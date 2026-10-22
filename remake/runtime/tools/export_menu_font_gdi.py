"""Rasterize menu digits with source-backed Windows GDI font parameters.

GAME.exe 0x5358C4 specifies positive lfHeight, weight400, charset1,
quality4, one pixel character extra and two diagonal shadow passes. This
tool exports masks using the local Windows font resolver, not game captures.
The original font directory has no bundled font files. Font resolution and
32-bit DIB output can differ from an original 16-bit DirectDraw surface.
"""
import ctypes as C
from ctypes import wintypes as W
from pathlib import Path
import hashlib
import json
import sys

from PIL import Image

RUNTIME = Path(__file__).resolve().parents[1]
OUT = RUNTIME / 'web/assets/menu/fonts'
MANIFEST = RUNTIME / 'web/data/menu_fonts.json'


class LOGFONT(C.Structure):
    _fields_ = [(name, W.LONG) for name in ['height','width','escapement','orientation','weight']] + \
        [(name,W.BYTE) for name in ['italic','underline','strikeout','charset','outprecision','clipprecision','quality','pitch']] + [('face',W.WCHAR*32)]


class BITMAPINFOHEADER(C.Structure):
    _fields_ = [('size',W.DWORD),('width',W.LONG),('height',W.LONG),('planes',W.WORD),('bits',W.WORD),
                ('compression',W.DWORD),('sizeimage',W.DWORD),('xppm',W.LONG),('yppm',W.LONG),('used',W.DWORD),('important',W.DWORD)]


class SIZE(C.Structure):
    _fields_ = [('cx',W.LONG),('cy',W.LONG)]


def export(font_specs=None, charset=None, preserve=False, cell_width=80, cell_height=64, columns=14, character_extra=1):
    if sys.platform != 'win32':
        raise RuntimeError('Windows GDI is required for this exporter')
    gdi = C.WinDLL('gdi32',use_last_error=True)
    gdi.CreateCompatibleDC.argtypes=[W.HDC];gdi.CreateCompatibleDC.restype=W.HDC
    gdi.CreateDIBSection.argtypes=[W.HDC,C.POINTER(BITMAPINFOHEADER),W.UINT,C.POINTER(C.c_void_p),W.HANDLE,W.DWORD];gdi.CreateDIBSection.restype=W.HBITMAP
    gdi.CreateFontIndirectW.argtypes=[C.POINTER(LOGFONT)];gdi.CreateFontIndirectW.restype=W.HFONT
    gdi.SelectObject.argtypes=[W.HDC,W.HGDIOBJ];gdi.SelectObject.restype=W.HGDIOBJ
    gdi.DeleteObject.argtypes=[W.HGDIOBJ];gdi.DeleteDC.argtypes=[W.HDC]
    gdi.TextOutW.argtypes=[W.HDC,C.c_int,C.c_int,W.LPCWSTR,C.c_int];gdi.TextOutW.restype=W.BOOL
    gdi.GetTextExtentPoint32W.argtypes=[W.HDC,W.LPCWSTR,C.c_int,C.POINTER(SIZE)];gdi.GetTextExtentPoint32W.restype=W.BOOL
    gdi.GetCharWidthA.argtypes=[W.HDC,W.UINT,W.UINT,C.POINTER(C.c_int)];gdi.GetCharWidthA.restype=W.BOOL
    gdi.GetTextFaceW.argtypes=[W.HDC,C.c_int,W.LPWSTR];gdi.GetTextFaceW.restype=C.c_int
    gdi.SetTextColor.argtypes=[W.HDC,W.DWORD];gdi.SetBkColor.argtypes=[W.HDC,W.DWORD]
    gdi.SetBkMode.argtypes=[W.HDC,C.c_int];gdi.SetTextCharacterExtra.argtypes=[W.HDC,C.c_int]
    gdi.GdiFlush.argtypes=[]
    dc=gdi.CreateCompatibleDC(None)
    if not dc: raise C.WinError(C.get_last_error())
    width,height=cell_width,cell_height
    info=BITMAPINFOHEADER(C.sizeof(BITMAPINFOHEADER),width,-height,1,32,0,width*height*4,0,0,0,0)
    bits=C.c_void_p();bitmap=gdi.CreateDIBSection(dc,C.byref(info),0,C.byref(bits),None,0)
    if not bitmap: gdi.DeleteDC(dc);raise C.WinError(C.get_last_error())
    oldbitmap=gdi.SelectObject(dc,bitmap)
    result=json.loads(MANIFEST.read_text(encoding='utf-8')) if preserve and MANIFEST.exists() else {'schema':'seventh-seal-menu-gdi-fonts','version':1,'evidence_type':'source-parameter-derived-local-GDI',
        'native_procedure':'0x5358c4','native_evidence_id':'ev_c48550266bebc70c8a5405748efb6d040a083188fee31bc67ebed4633b5077a9',
        'parameters':{'positive_lfHeight':True,'lfWeight':400,'lfCharSet':1,'lfQuality':4,'character_extra':1,
            'shadow_offsets':[[-1,-1],[1,1]],'text_origin':'GDI TextOut top-left cell origin'},
        'limitations':['Derived on current Windows font installation; not pixels captured from GAME.exe.',
            '32-bit DIB antialias masks may differ from 16-bit DirectDraw quantization.'], 'fonts':{}}
    try:
        OUT.mkdir(parents=True,exist_ok=True)
        for key,face,size in (font_specs or [('simsun18','宋体',18),('simsun20','宋体',20),('simsun24','宋体',24),('simsun26','宋体',26),('arial24','Arial',24),('arial26','Arial',26)]):
            lf=LOGFONT();lf.height=size;lf.weight=400;lf.charset=1;lf.quality=4;lf.face=face
            font=gdi.CreateFontIndirectW(C.byref(lf))
            if not font:raise C.WinError(C.get_last_error())
            oldfont=gdi.SelectObject(dc,font)
            try:
                actual=C.create_unicode_buffer(128);gdi.GetTextFaceW(dc,128,actual)
                gdi.SetTextCharacterExtra(dc,character_extra);gdi.SetBkMode(dc,1);gdi.SetTextColor(dc,0xffffff)
                characters=charset or '0123456789/ -x'
                atlas=Image.new('RGBA',(width*columns,height*((len(characters)+columns-1)//columns)),(0,0,0,0));glyphs={}
                for index,char in enumerate(characters):
                    C.memset(bits,0,width*height*4)
                    if not gdi.TextOutW(dc,3,3,char,1):raise C.WinError(C.get_last_error())
                    gdi.GdiFlush()
                    raw=C.string_at(bits,width*height*4)
                    mask=Image.frombytes('RGB',(width,height),raw,'raw','BGRX').getchannel('R')
                    extent=SIZE()
                    if not gdi.GetTextExtentPoint32W(dc,char,1,C.byref(extent)):raise C.WinError(C.get_last_error())
                    bbox=mask.getbbox()
                    if bbox:
                        ink=Image.new('RGBA',(bbox[2]-bbox[0],bbox[3]-bbox[1]),(255,255,255,255));ink.putalpha(mask.crop(bbox))
                        atlas_x,atlas_y=(index%columns)*width,(index//columns)*height
                        atlas.alpha_composite(ink,(atlas_x,atlas_y))
                        glyphs[char]={'x':atlas_x,'y':atlas_y,'width':ink.width,'height':ink.height,
                            'offset_x':bbox[0]-3,'offset_y':bbox[1]-3,'advance':extent.cx}
                    else:glyphs[char]={'x':(index%columns)*width,'y':(index//columns)*height,'width':0,'height':0,'offset_x':0,'offset_y':0,'advance':extent.cx}
                    if ord(char)<128:
                        char_width=C.c_int()
                        if not gdi.GetCharWidthA(dc,ord(char),ord(char),C.byref(char_width)):raise C.WinError(C.get_last_error())
                        # 0x5341A1/0x53434C measure ASCII groups with this
                        # value; TextOut itself still has charExtra=1.
                        glyphs[char]['char_width']=char_width.value
                dest=OUT/(key+'.png');atlas.save(dest)
                result['fonts'][key]={'face_requested':face,'face_resolved':actual.value,'height':size,
                    'image':dest.relative_to(RUNTIME/'web').as_posix(),'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),
                    'atlas_width':atlas.width,'atlas_height':atlas.height,'glyphs':glyphs}
            finally:gdi.SelectObject(dc,oldfont);gdi.DeleteObject(font)
    finally:gdi.SelectObject(dc,oldbitmap);gdi.DeleteObject(bitmap);gdi.DeleteDC(dc)
    MANIFEST.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'manifest':str(MANIFEST),'fonts':{k:v['face_resolved'] for k,v in result['fonts'].items()}},ensure_ascii=False))


if __name__=='__main__':
    # Both command names rebuild the full recipe. The low-level export()
    # function remains available to the coordinator without recursive dispatch.
    sys.path.insert(0,str(Path(__file__).resolve().parent))
    from export_menu_text_gdi import main
    main()
