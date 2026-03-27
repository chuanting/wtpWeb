"""
济南市 4G/5G 流量可视化 — 后端服务
启动: python server.py
访问: http://localhost:5000
"""
import json
import math
import os
import queue
import threading
import time
from datetime import datetime
from functools import lru_cache

import numpy as np
import pandas as pd
from flask import Flask, Response, jsonify, request, send_file, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# 切换到 server.py 所在目录，确保相对路径始终正确
os.chdir(BASE_DIR)

app = Flask(__name__, static_folder=os.path.join(BASE_DIR, 'static'))


# ── 静态文件 ──────────────────────────────────────────
@app.route('/')
def index():
    return send_file(os.path.join(BASE_DIR, 'index.html'))


# ── 数据加载（懒加载 + 缓存）────────────────────────────
_csv_cache: dict = {}


def load_csv(net: str, direction: str) -> pd.DataFrame:
    key = f'{net}_{direction}'
    if key not in _csv_cache:
        fname = os.path.join(BASE_DIR, f'{net}_{direction}.csv')
        _csv_cache[key] = pd.read_csv(fname, index_col=0, parse_dates=True)
    return _csv_cache[key]


# ── API: 单街道 15 分钟时序 ───────────────────────────
@app.route('/api/street/<street_id>')
def street_series(street_id: str):
    net = request.args.get('net', '5g')       # '4g' | '5g'
    direction = request.args.get('dir', 'down')  # 'down' | 'up'

    try:
        df = load_csv(net, direction)
        if street_id not in df.columns:
            return jsonify({'error': f'Street {street_id} not found in {net}_{direction}'}), 404

        series = (df[street_id] / 1e6).round(2)
        result = {
            'times':  [t.strftime('%Y-%m-%d %H:%M') for t in df.index],
            'values': series.tolist(),
        }
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── API: 训练（SSE 流）────────────────────────────────
@app.route('/api/train')
def train_api():
    street_id = request.args.get('id', '370102001')
    net       = request.args.get('net', '5g')

    def stream():
        q: queue.Queue = queue.Queue()
        t = threading.Thread(target=_train_worker, args=(street_id, net, q), daemon=True)
        t.start()
        while True:
            msg = q.get()
            yield f'data: {json.dumps(msg, ensure_ascii=False)}\n\n'
            if msg.get('type') == 'done' or msg.get('type') == 'error':
                break

    return Response(
        stream(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
        },
    )


def _now_str() -> str:
    return datetime.now().strftime('%H:%M:%S.%f')[:-3]


def _send(q: queue.Queue, msg_type: str, **kwargs):
    q.put({'type': msg_type, 'time': _now_str(), **kwargs})


def _make_features(series: pd.Series) -> pd.DataFrame:
    """构建时序预测特征"""
    df = pd.DataFrame({'target': series.values}, index=series.index)
    df['hour']       = series.index.hour
    df['minute']     = series.index.minute // 15          # 0-3
    df['dayofweek']  = series.index.dayofweek
    df['is_weekend'] = (series.index.dayofweek >= 5).astype(int)
    df['hour_sin']   = np.sin(2 * np.pi * series.index.hour / 24)
    df['hour_cos']   = np.cos(2 * np.pi * series.index.hour / 24)
    df['dow_sin']    = np.sin(2 * np.pi * series.index.dayofweek / 7)
    df['dow_cos']    = np.cos(2 * np.pi * series.index.dayofweek / 7)

    # Lag 特征（15分钟粒度）
    for lag in [1, 2, 4, 8, 12, 24, 48, 96]:
        df[f'lag_{lag}'] = series.shift(lag).values

    # 滑窗统计
    for w in [4, 12, 96]:
        df[f'roll_mean_{w}'] = series.rolling(w, min_periods=1).mean().values
        df[f'roll_std_{w}']  = series.rolling(w, min_periods=1).std().fillna(0).values
        df[f'roll_max_{w}']  = series.rolling(w, min_periods=1).max().values

    return df.dropna()


def _train_worker(street_id: str, net: str, q: queue.Queue):
    try:
        import lightgbm as lgb
        from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
    except ImportError as e:
        _send(q, 'error', msg=f'缺少依赖: {e}')
        return

    results = {}  # 存放两个方向的训练结果

    for direction, dir_label in [('down', '下行'), ('up', '上行')]:
        _send(q, 'phase', msg=f'▶ 开始训练 {net.upper()} {dir_label}流量预测模型',
              direction=direction)
        time.sleep(0.1)

        # 加载数据
        _send(q, 'log', msg=f'载入 {net.upper()} {dir_label} 流量数据...', level='info')
        try:
            df_raw = load_csv(net, direction)
            if street_id not in df_raw.columns:
                _send(q, 'log', msg=f'街道 {street_id} 在 {net}_{direction} 中不存在，跳过',
                      level='warn')
                continue
            series = df_raw[street_id] / 1e6  # 单位：MB
        except Exception as e:
            _send(q, 'log', msg=f'数据加载失败: {e}', level='error')
            continue

        _send(q, 'log',
              msg=f'数据加载完成 | 时间步: {len(series)} | '
                  f'均值: {series.mean():.2f} MB | 峰值: {series.max():.2f} MB',
              level='success')
        time.sleep(0.05)

        # 特征工程
        _send(q, 'log', msg='开始特征工程...', level='info')
        feat_names = [
            'hour', 'minute', 'dayofweek', 'is_weekend',
            'hour_sin', 'hour_cos', 'dow_sin', 'dow_cos',
            'lag_1', 'lag_2', 'lag_4', 'lag_8', 'lag_12', 'lag_24', 'lag_48', 'lag_96',
            'roll_mean_4', 'roll_std_4', 'roll_max_4',
            'roll_mean_12', 'roll_std_12', 'roll_max_12',
            'roll_mean_96', 'roll_std_96', 'roll_max_96',
        ]
        df_feat = _make_features(series)
        _send(q, 'log',
              msg=f'特征工程完成 | 特征数: {len(feat_names)} | 有效样本: {len(df_feat)}',
              level='success')
        time.sleep(0.05)

        # 划分训练/测试集
        split = int(len(df_feat) * 0.8)
        feature_cols = [c for c in df_feat.columns if c != 'target']
        X_train = df_feat.iloc[:split][feature_cols].values
        y_train = df_feat.iloc[:split]['target'].values
        X_test  = df_feat.iloc[split:][feature_cols].values
        y_test  = df_feat.iloc[split:]['target'].values

        _send(q, 'log',
              msg=f'数据划分 | 训练集: {len(X_train)} 条 (80%) | 测试集: {len(X_test)} 条 (20%)',
              level='info')
        time.sleep(0.05)

        # 构建 LightGBM Dataset
        train_set = lgb.Dataset(X_train, label=y_train, feature_name=feature_cols)
        valid_set = lgb.Dataset(X_test,  label=y_test,  reference=train_set)

        params = {
            'objective':        'regression',
            'metric':           ['rmse', 'mae'],
            'num_leaves':       63,
            'learning_rate':    0.05,
            'feature_fraction': 0.8,
            'bagging_fraction': 0.8,
            'bagging_freq':     5,
            'min_child_samples': 20,
            'verbose':          -1,
            'n_jobs':           -1,
        }
        N_ITERS = 300

        _send(q, 'log', msg=f'LightGBM 参数初始化完成 | 迭代次数: {N_ITERS}', level='info')
        _send(q, 'log', msg='▶ 开始迭代训练...', level='info')
        time.sleep(0.1)

        train_start = time.time()
        iter_records = []

        class ProgressCallback:
            def __init__(self):
                self.order = 0

            def __call__(self, env):
                it = env.iteration
                if it % 10 == 0 or it == N_ITERS - 1:
                    elapsed = time.time() - train_start
                    eta = elapsed / (it + 1) * (N_ITERS - it - 1) if it > 0 else 0
                    results_list = env.evaluation_result_list
                    rmse = next((r[2] for r in results_list if 'rmse' in r[1].lower()), 0)
                    mae  = next((r[2] for r in results_list if 'mae'  in r[1].lower()), 0)
                    pct  = (it + 1) / N_ITERS * 100
                    iter_records.append({'iter': it, 'rmse': rmse, 'mae': mae})
                    _send(q, 'iter',
                          direction=direction,
                          iter=it + 1,
                          total=N_ITERS,
                          pct=round(pct, 1),
                          rmse=round(rmse, 4),
                          mae=round(mae, 4),
                          elapsed=round(elapsed, 1),
                          eta=round(eta, 1))
                    time.sleep(0.02)  # 控制刷新速率，让前端可见

        model = lgb.train(
            params,
            train_set,
            num_boost_round=N_ITERS,
            valid_sets=[valid_set],
            callbacks=[ProgressCallback()],
        )

        # 评估
        y_pred = model.predict(X_test)
        rmse  = math.sqrt(mean_squared_error(y_test, y_pred))
        mae   = mean_absolute_error(y_test, y_pred)
        r2    = r2_score(y_test, y_pred)
        mape  = np.mean(np.abs((y_test - y_pred) / (y_test + 1e-6))) * 100

        elapsed_total = time.time() - train_start
        _send(q, 'log',
              msg=f'✓ {dir_label}模型训练完成 | 耗时: {elapsed_total:.1f}s',
              level='success')
        _send(q, 'metrics',
              direction=direction,
              label=dir_label,
              rmse=round(rmse, 4),
              mae=round(mae, 4),
              r2=round(r2, 4),
              mape=round(mape, 2))

        # 发送预测 vs 真实（最后 96 个点 = 24 小时）
        n_show = min(96, len(y_test))
        test_times = [
            df_feat.index[split + i].strftime('%m-%d %H:%M')
            for i in range(n_show)
        ]
        results[direction] = {
            'times':  test_times,
            'actual': [round(float(v), 3) for v in y_test[:n_show]],
            'pred':   [round(float(v), 3) for v in y_pred[:n_show]],
        }

        time.sleep(0.1)

    # 所有方向训练完成
    _send(q, 'done', results=results)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8765))
    print("\n" + "═" * 50)
    print("  济南市 4G/5G 流量可视化系统")
    print("═" * 50)
    print(f"  访问: http://localhost:{port}")
    print("  请确保已运行 python preprocess.py")
    print("═" * 50 + "\n")
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
