const owners=new WeakMap(),listeners=new Set();
export function ownBitmap(bitmap,pool,index){owners.set(bitmap,{pool,index});}
export function bitmapResident(bitmap){const owner=owners.get(bitmap);return owner?owner.pool.pages.get(owner.index)?.bitmap===bitmap:null;}
export function onBitmapEvicted(listener){listeners.add(listener);return ()=>listeners.delete(listener);}
export function evictBitmap(bitmap){for(const listener of listeners)listener(bitmap);bitmap.close?.();}
