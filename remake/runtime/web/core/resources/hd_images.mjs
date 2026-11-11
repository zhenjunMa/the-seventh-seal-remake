const preferenceKey = 'seal:hd-images';
const directory = '/assets/hd/';
const supported = [
  /^dialogue_ui\/(?:faces_\d+|(?:board|think|map_name|reward)_000)\.png$/i,
  /^world_map\/locate_\d+\/image_000\.png$/i,
  /^prologue_loading\/(?:background_\d+|progress\/image_000)\.png$/i,
  /^maps\/[a-z\d_-]+\/(?:background|objects\/\d+_frame_000)\.png$/i,
  /^(?:stages\/stage\d+|forest_stage)\/[a-z\d_]+\/frame_000\.png$/i,
  /^startup\/(?:(?:menulbk|menulbx|specialback)\/frame_000|menuback\/frame_00[0-5])\.png$/i,
  /^startup\/(?:(?:menubtn|menusub[0-3]2?)\/frame_\d{3}|menuhlp[0-3][0-2]\/frame_000)\.png$/i,
  /^startup\/menuspecial(?:0[01]|30)\/frame_\d{3}\.png$/i,
  /^menu\/(?:[a-z\d_]+\/)*[a-z\d_]+\.png$/i,
  /^(?:native_services|battle_ui|battle_result)\/[a-z\d_]+\/image_000\.png$/i,
  /^native_services\/(?:ndback|nomoney|(?:worddiscback|lottoback|rotateback|slottoback)\/frame_\d+)\.png$/i,
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

export function loadHdImage(path, original, createImage = () => new Image()) {
  if (!enabled || typeof path !== 'string') return null;
  const key = '/' + path.replace(/^\/+/, '');
  if (!key.startsWith('/assets/') || !supported.some(pattern => pattern.test(key.slice(8)))) return null;
  return readManifest().then(pack => {
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
    return new Promise(resolve => {
      const bitmap = createImage();
      const finish = image => {
        bitmap.onload = bitmap.onerror = null;
        resolve(image);
      };
      bitmap.onload = () => finish(bitmap.width === w * scale && bitmap.height === h * scale
        ? describe(bitmap, path, width, height, scale, rect) : null);
      bitmap.onerror = () => finish(null);
      bitmap.src = directory + key.slice('/assets/'.length);
    });
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
