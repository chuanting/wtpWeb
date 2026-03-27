"""
一次性数据预处理脚本
输出：
  static/data/geo.json        — 街道边界 GeoJSON（精简属性）
  static/data/meta.json       — 街道元数据（id -> name/district/center）
  static/data/map_data.json   — 小时级聚合流量（用于地图动画）
"""
import json
import pandas as pd
import numpy as np
import os

OUT_DIR = 'static/data'
os.makedirs(OUT_DIR, exist_ok=True)

print("═" * 50)
print("  济南市 4G/5G 流量数据预处理")
print("═" * 50)

# ── 1. 加载 GeoJSON ──────────────────────────────────
print("\n[1/4] 加载 GeoJSON...")
with open('5g.geojson', encoding='utf-8') as f:
    geo5g = json.load(f)
with open('4g.geojson', encoding='utf-8') as f:
    geo4g = json.load(f)

print(f"  5G 边界: {len(geo5g['features'])} 个街道")
print(f"  4G 边界: {len(geo4g['features'])} 个街道")

# ── 2. 构建元数据 ──────────────────────────────────────
print("\n[2/4] 构建街道元数据...")
streets_meta = {}
for feat in geo5g['features']:
    p = feat['properties']
    uid = p['unique_id']
    parts = p.get('ext_path', '').split(' ')
    district = parts[2] if len(parts) > 2 else ''
    # 解析中心点
    wkt = p.get('geo_wkt', 'POINT (0 0)')
    coords_str = wkt.replace('POINT (', '').replace(')', '').strip()
    lon, lat = map(float, coords_str.split())
    streets_meta[uid] = {
        'id': uid,
        'name': p['name'],
        'district': district,
        'ext_path': p.get('ext_path', ''),
        'center': [lon, lat]
    }

with open(f'{OUT_DIR}/meta.json', 'w', encoding='utf-8') as f:
    json.dump(streets_meta, f, ensure_ascii=False, separators=(',', ':'))
print(f"  → meta.json ({len(streets_meta)} 条记录)")

# ── 3. 精简 GeoJSON ────────────────────────────────────
print("\n[3/4] 精简并保存 GeoJSON...")

def clean_geo(geo_data):
    """仅保留 id 和 name 属性，减小文件体积"""
    return {
        'type': 'FeatureCollection',
        'features': [
            {
                'type': 'Feature',
                'properties': {
                    'id': f['properties']['unique_id'],
                    'name': f['properties']['name'],
                    'district': f['properties'].get('ext_path', '').split(' ')[2]
                               if len(f['properties'].get('ext_path', '').split(' ')) > 2 else ''
                },
                'geometry': f['geometry']
            }
            for f in geo_data['features']
        ]
    }

geo_clean = clean_geo(geo5g)  # 5G 和 4G 边界相同，用 5G 即可
with open(f'{OUT_DIR}/geo.json', 'w', encoding='utf-8') as f:
    json.dump(geo_clean, f, ensure_ascii=False, separators=(',', ':'))
size_geo = os.path.getsize(f'{OUT_DIR}/geo.json') / 1024
print(f"  → geo.json ({size_geo:.0f} KB)")

# ── 4. 加载并处理流量 CSV ──────────────────────────────
print("\n[4/4] 加载流量数据并聚合...")
dfs = {}
csv_files = {
    '5g_down': '5g_down.csv',
    '5g_up':   '5g_up.csv',
    '4g_down': '4g_down.csv',
    '4g_up':   '4g_up.csv',
}
for key, fname in csv_files.items():
    print(f"  读取 {fname}...", end=' ', flush=True)
    df = pd.read_csv(fname, index_col=0, parse_dates=True)
    dfs[key] = df
    print(f"shape={df.shape}")

# 街道列表
streets_5g = list(dfs['5g_down'].columns)
streets_4g = list(dfs['4g_down'].columns)

print(f"\n  5G 街道数: {len(streets_5g)}")
print(f"  4G 街道数: {len(streets_4g)}")
print(f"  时间范围: {dfs['5g_down'].index[0]} → {dfs['5g_down'].index[-1]}")
print(f"  时间步数: {len(dfs['5g_down'])} (15分钟粒度)")

# 聚合为小时级别（用于地图动画）
print("\n  聚合为小时级别...")
dfs_hourly = {k: v.resample('1h').sum() for k, v in dfs.items()}
n_hours = len(dfs_hourly['5g_down'])
print(f"  小时步数: {n_hours}")

# 转换单位为 MB，保留 2 位小数
def to_mb(df):
    return (df / 1e6).round(2)

# 构建 map_data.json
times_hourly = [t.strftime('%Y-%m-%d %H:%M') for t in dfs_hourly['5g_down'].index]
times_15m    = [t.strftime('%Y-%m-%d %H:%M') for t in dfs['5g_down'].index]

print("\n  构建 map_data.json...")
map_data = {
    'times':       times_hourly,
    'streets_5g':  streets_5g,
    'streets_4g':  streets_4g,
    '5g_down':     to_mb(dfs_hourly['5g_down']).values.tolist(),
    '5g_up':       to_mb(dfs_hourly['5g_up']).values.tolist(),
    '4g_down':     to_mb(dfs_hourly['4g_down']).values.tolist(),
    '4g_up':       to_mb(dfs_hourly['4g_up']).values.tolist(),
}

with open(f'{OUT_DIR}/map_data.json', 'w') as f:
    json.dump(map_data, f, separators=(',', ':'))
size_map = os.path.getsize(f'{OUT_DIR}/map_data.json') / 1024 / 1024
print(f"  → map_data.json ({size_map:.2f} MB)")

print("\n═" * 26)
print("  预处理完成！")
print("═" * 26)
print("\n下一步：运行 python server.py")
