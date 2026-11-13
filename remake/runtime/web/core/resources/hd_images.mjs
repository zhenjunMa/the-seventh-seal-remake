const preferenceKey = 'seal:hd-images';
const directory = '/assets/hd/';
const mapBackground = /^\/assets\/maps\/[a-z\d_-]+\/background\.png$/i;
const supported = [
  /^dialogue_ui\/(?:faces_\d+|(?:board|think|map_name|reward)_000|wait[12]_\d+)\.png$/i,
  /^world_map\/locate_\d+\/image_\d+\.png$/i,
  /^prologue\/wait_\d+\.png$/i,
  /^prologue_loading\/(?:background_\d+|progress\/image_00[01])\.png$/i,
  /^maps\/[a-z\d_-]+\/(?:background|objects\/\d+_frame_000)\.png$/i,
  /^(?:stages\/stage\d+|forest_stage|skill_test_stage)\/[a-z\d_]+\/(?:frame|intrinsic)_000\.png$/i,
  /^startup\/(?:(?:menulbk|menulbx|specialback)\/frame_000|menuback\/frame_00[0-5])\.png$/i,
  /^startup\/(?:(?:menubtn|menusub[0-3]2?)\/frame_\d{3}|menuhlp[0-3][0-2]\/frame_000)\.png$/i,
  /^startup\/menuspecial(?:0[01]|30)\/frame_\d{3}\.png$/i,
  /^menu\/(?:[a-z\d_]+\/)*[a-z\d_]+\.png$/i,
  /^battle_result\/[a-z\d_]+\/image_000\.png$/i,
  /^battle_result\/(?:fight_report_01\/frame_000_inverse_mask|fight_report_02\/frame_\d{3}|victor\/frame_\d{3}(?:_indexed)?)\.png$/i,
  /^(?:battle_ui|native_services)\/(?:[a-z\d_]+\/)*[a-z\d_]+\.png$/i,
];

let enabled = false;
let manifest;

export function hdImagesPreference() {
  try { return localStorage.getItem(preferenceKey) === 'on'; }
  catch { return false; }
}

export function saveHdImagesPreference(value) {
  localStorage.setItem(preferenceKey, value ? 'on' : 'off');
}

export function configureHdImages(value) {
  enabled = value;
  manifest = undefined;
}

export const hdImagesEnabled = () => enabled;

function readManifest() {
  manifest ??= fetch(directory + 'manifest.json', {cache: 'no-cache'})
    .then(response => response.ok ? response.json() : null)
    .then(data => data?.version === 1 ? data : null)
    .catch(() => null);
  return manifest;
}

// Keep source rectangles in original coordinates. Large images are exposed as
// regions small enough for the renderer's existing texture slicing path.
function describe(bitmap, path, width, height, pixelScale, rect) {
  const size = Math.floor(2048 / pixelScale);
  const [left, top, w, h] = rect ?? [0, 0, width, height];
  const regions = [];
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      regions.push([left + x, top + y, Math.min(size, w - x), Math.min(size, h - y), 0,
        x * pixelScale, y * pixelScale]);
    }
  }
  return {packed: true, path, width, height, pixelScale, hdUrl: bitmap.src, hdRect: rect, regions, pool: {pages: new Map([[0, {bitmap}]])}};
}

function loadImage(url, width, height, createImage) {
  return new Promise(resolve => {
    const bitmap = createImage();
    const finish = image => {
      bitmap.onload = bitmap.onerror = null;
      resolve(image);
    };
    bitmap.onload = () => finish(bitmap.width === width && bitmap.height === height ? bitmap : null);
    bitmap.onerror = () => finish(null);
    bitmap.src = url;
  });
}

async function loadMapTiles(key, {width, height, scale, tiles}, read, visible) {
  const {sourceSha256, size} = tiles;
  if (!/^[a-f0-9]{64}$/.test(sourceSha256) || size !== Math.floor(1024 / scale)) return null;
  const base = directory + `map_tiles/${sourceSha256}-${size}`;
  const regions = [], pages = new Map(), loads = [];
  for (let y = 0; y < height; y += size) for (let x = 0; x < width; x += size) {
    const w = Math.min(size, width - x), h = Math.min(size, height - y), page = regions.length;
    if (visible && !visible({x, y, width:w, height:h})) continue;
    regions.push([x, y, w, h, page, 0, 0]);
    loads.push(read(`${base}/${x}-${y}.png`, w * scale, h * scale).then(bitmap => {
      if (bitmap) pages.set(page, {bitmap});
    }));
  }
  await Promise.all(loads);
  if (pages.size !== regions.length) return null;
  return {packed: true, path: key, width, height, pixelScale: scale, regions, pool: {pages}};
}

export function loadHdImage(path, original, createImage = () => new Image(), {readMapPage, visible} = {}) {
  if (!enabled || typeof path !== 'string') return null;
  const key = '/' + path.replace(/^\/+/, '');
  if (!key.startsWith('/assets/') || !supported.some(pattern => pattern.test(key.slice(8)))) return null;
  return readManifest().then(async pack => {
    const entry = pack?.images?.[key];
    if (!entry) return null;
    const {width, height, scale, rect, sourceSha256} = entry;
    if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0 ||
        ![2, 3, 4].includes(scale) ||
        (original && (width !== original.width || height !== original.height)) ||
        (sourceSha256 !== undefined && sourceSha256 !== original?.sha256)) return null;
    if (rect !== undefined && (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isSafeInteger))) return null;
    const [x, y, w, h] = rect ?? [0, 0, width, height];
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > width || y + h > height) return null;
    const read = mapBackground.test(key) && readMapPage
      ? readMapPage : (url, w, h) => loadImage(url, w, h, createImage);
    if (entry.tiles && rect === undefined && mapBackground.test(key)) {
      const tiled = await loadMapTiles(key, entry, read, visible);
      if (tiled || visible) return tiled;
    }
    const bitmap = await read(directory + key.slice('/assets/'.length), w * scale, h * scale);
    return bitmap ? describe(bitmap, path, width, height, scale, rect) : null;
  }).catch(() => null);
}

export async function loadHdFont(font, createImage) {
  if (!enabled) return null;
  const key = '/' + font.image.replace(/^\/+/, '');
  if (!/^\/assets\/fonts\/(?:windows\/)?(?:menu|dialogue|prologue)\/[a-z\d_]+\.png$/i.test(key)) return null;
  const pack = await readManifest();
  if (!font.sha256 || pack?.fonts?.[key] !== font.sha256) return null;
  const url = directory + key.slice(8);
  try {
    const response = await fetch(url.replace(/\.png$/, '.json'), {cache: 'no-cache'});
    if (!response.ok) return null;
    const {width, height, scale, glyphs} = await response.json();
    if (scale !== 2 || !Number.isInteger(width) || !Number.isInteger(height) ||
        !Object.keys(font.glyphs).every(char => {
          const g = glyphs?.[char];
          return g && [g.x,g.y,g.width,g.height,g.offset_x,g.offset_y].every(Number.isInteger) &&
            g.x >= 0 && g.y >= 0 && g.width >= 0 && g.height >= 0 &&
            g.x+g.width <= width && g.y+g.height <= height;
        })) return null;
    const image = createImage();
    if (image.decode) {
      image.src = url;
      await image.decode();
    } else {
      await new Promise((resolve,reject) => { image.onload=resolve; image.onerror=reject; image.src=url; });
    }
    return image.width === width && image.height === height ? {image, scale, glyphs} : null;
  } catch { return null; }
}
