import os
from html import escape
from flask import Flask, request, jsonify, Response, send_from_directory
import requests

app = Flask(__name__, static_folder='static')
app.config['MAX_CONTENT_LENGTH'] = 32 * 1024

VOICES = {
 'zh-CN-XiaoyouNeural': {'locale':'zh-CN','styles':[]},
 'zh-CN-XiaoshuangNeural': {'locale':'zh-CN','styles':['chat']},
 'zh-CN-XiaomengNeural': {'locale':'zh-CN','styles':['chat']},
 'zh-CN-XiaoxiaoNeural': {'locale':'zh-CN','styles':['cheerful','affectionate','gentle','chat','whispering']},
 'zh-CN-XiaoyiNeural': {'locale':'zh-CN','styles':['cheerful','affectionate','gentle']},
 'zh-CN-XiaoyouMultilingualNeural': {'locale':'zh-CN','styles':['cute','cheerful','chat','story']},
 'en-US-AvaNeural': {'locale':'en-US','styles':['cheerful','friendly','whispering']},
 'en-US-JennyNeural': {'locale':'en-US','styles':['cheerful','friendly','excited']},
}

@app.get('/')
def home():
 return send_from_directory('static','index.html')

@app.get('/api/health')
def health():
 return jsonify(ok=True, configured=bool(os.environ.get('AZURE_SPEECH_KEY') and os.environ.get('AZURE_SPEECH_REGION')))

@app.post('/api/speak')
def speak():
 key = os.environ.get('AZURE_SPEECH_KEY','').strip()
 region = os.environ.get('AZURE_SPEECH_REGION','').strip().lower()
 if not key or not region:
  return jsonify(error='服务器尚未配置 AZURE_SPEECH_KEY 和 AZURE_SPEECH_REGION'),503
 data = request.get_json(silent=True) or {}
 text = data.get('text','')
 voice = data.get('voice','zh-CN-XiaoyouNeural')
 style = data.get('style','default')
 try:
  rate = int(data.get('rate',0)); pitch = int(data.get('pitch',0)); degree = float(data.get('degree',1))
 except (ValueError, TypeError):
  return jsonify(error='参数格式无效'),400
 if not isinstance(text,str) or not text.strip() or len(text)>1200:
  return jsonify(error='请输入 1–1200 字的文本'),400
 if voice not in VOICES: return jsonify(error='不支持的音色'),400
 if not isinstance(style,str) or style not in ['default']+VOICES[voice]['styles']:
  return jsonify(error='当前音色不支持此情绪风格'),400
 if not (-40<=rate<=70 and -20<=pitch<=30 and 0.5<=degree<=1.5):
  return jsonify(error='参数超出允许范围'),400
 meta=VOICES[voice]
 safe=escape(text,quote=False)
 inner=f'<prosody rate="{rate:+d}%" pitch="{pitch:+d}%">{safe}</prosody>'
 if style!='default': inner=f'<mstts:express-as style="{style}" styledegree="{degree:.1f}">{inner}</mstts:express-as>'
 ssml=(f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
       f'xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="{meta["locale"]}">'
       f'<voice name="{voice}">{inner}</voice></speak>')
 headers={'Ocp-Apim-Subscription-Key':key,'Content-Type':'application/ssml+xml',
          'X-Microsoft-OutputFormat':'audio-24khz-96kbitrate-mono-mp3','User-Agent':'CuteAzureTTS'}
 try:
  r=requests.post(f'https://{region}.tts.speech.microsoft.com/cognitiveservices/v1',data=ssml.encode('utf-8'),headers=headers,timeout=35)
 except requests.RequestException:
  return jsonify(error='Azure 连接失败，请检查区域、网络和服务状态'),502
 if r.status_code!=200:
  errors={401:'Azure 密钥无效或区域不匹配',403:'Azure 拒绝访问，请检查服务权限',429:'Azure 调用频率或配额已达限制'}
  return jsonify(error=errors.get(r.status_code,f'Azure 返回错误 HTTP {r.status_code}；请核查语音是否在此区域可用')),502
 return Response(r.content,content_type='audio/mpeg',headers={'Cache-Control':'no-store','Content-Disposition':'inline; filename="cute-voice.mp3"'})

if __name__=='__main__':
 app.run(host='127.0.0.1',port=8088)
