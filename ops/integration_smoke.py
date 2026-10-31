"""HTTP/WS integration check against ops/dev.py --mock --test-db; no model inference."""
import io
import json
from pathlib import Path
import secrets
import sys
import time
import urllib.error
import urllib.request
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'server/scripts'))
from process_smoke import WS, request

GO = 'http://127.0.0.1:3000'
AI = 'http://127.0.0.1:8000'

def expect_error(base, path, body, status):
    try:
        request(base, path, body)
    except urllib.error.HTTPError as error:
        assert error.code == status, (path, error.code)
        return
    raise AssertionError('expected HTTP error: ' + path)

def main():
    assert request(GO, '/health')[1]['db'] == 'ok'
    health = request(AI, '/health')[1]
    assert health['mock_mode'] is True and health['backend'] == 'mock', 'Run middleware with MOCK_MODE=1'
    catalog = json.loads((ROOT / 'server/world/catalog.json').read_text())
    for npc, context in [('lao_wang', {'price': 800, 'price_floor': 120}), ('chef_chen', {'price': 150, 'price_floor': 40}), ('guard_zhang', {'price': 0, 'price_floor': 0})]:
        response = request(AI, '/dialogue', {'npc_id': npc, 'player_message': 'Привет!', 'context': context})[1]
        parsed = response['parsed']
        for key in ['speech_tokens', 'choices', 'emotion', 'fsm_state', 'price_new', 'mianzi_delta', 'aggro_delta']:
            assert parsed[key] == response[key]
        for token in parsed['speech_tokens']:
            assert token == catalog['words'][token['id']]
        assert len(parsed['choices']) == 4
    expect_error(AI, '/dialogue', {'npc_id': 'unknown', 'player_message': 'hello'}, 404)
    expect_error(AI, '/dialogue', {}, 422)
    with urllib.request.urlopen(AI + '/tts?text=%E4%BD%A0%E5%A5%BD', timeout=10) as response:
        assert response.headers['Content-Type'].startswith('audio/wav')
        with wave.open(io.BytesIO(response.read()), 'rb') as audio:
            assert audio.getnchannels() == 1 and audio.getframerate() == 16000
    expect_error(AI, '/tts', None, 422)
    suffix = secrets.token_hex(5)
    one = request(GO, '/auth/register', {'login': 'int_a_' + suffix, 'password': 'integration123', 'profile': 'culture'})[1]
    two = request(GO, '/auth/register', {'login': 'int_b_' + suffix, 'password': 'integration123'})[1]
    expect_error(GO, '/auth/register', {'login': one['player']['login'], 'password': 'integration123'}, 409)
    expect_error(GO, '/auth/login', {'login': one['player']['login'], 'password': 'wrongpassword'}, 401)
    expect_error(GO, '/auth/register', {'login': 'ab', 'password': 'short'}, 400)
    expect_error(GO, '/ws', None, 401)
    assert request(GO, '/auth/login', {'login': one['player']['login'], 'password': 'integration123'})[1]['player']['id'] == one['player']['id']
    a, b = WS(GO, one['token']), WS(GO, two['token'])
    try:
        a.until('WELCOME'); a.until('WORLD_STATS')
        b.until('WELCOME'); b.until('WORLD_STATS')
        a.send('MOVE', {'x':111, 'z':110, 'rotation':0.2})
        assert b.until('PLAYER_MOVE')['player_id'] == one['player']['id']
        a.send('CHAT', {'text':'integration chat'})
        assert b.until('CHAT')['text'] == 'integration chat'
        a.send('DIALOGUE', {'npc_id':'lao_wang'})
        speech = a.until('NPC_SPEECH')
        assert speech['fallback'] is False, 'Go rejected real middleware response'
        a.until('DIALOGUE_DONE')
        a.send('DIALOGUE', {'npc_id':'lao_wang', 'choice_id':1, 'turn_id':speech['turn_id']})
        assert a.until('NPC_SPEECH')['fallback'] is False
        a.until('DIALOGUE_DONE')
        a.send('INSPECT', {'item_id':'teapot'})
        quiz = a.until('QUIZ')
        a.send('INSPECT', {'item_id':'teapot', 'answer_id':catalog['items']['teapot']['answer_id'], 'quiz_id':quiz['quiz_id']})
        assert a.until('QUIZ_RESULT')['correct']
        a.send('TRADE_START', {'npc_id':'lao_wang', 'item_id':'jade_amulet'})
        proposal = a.until('TRADE_OPEN')
        confirmation = {k: proposal[k] for k in ['npc_id','item_id','trade_id']}
        confirmation['amount'] = 150
        a.send('CALCULATOR', confirmation)
        result = a.until('TRADE_RESULT')
        assert result['status'] == 'purchased'
        assert a.until('BALANCE')['balance'] == 350
        assert a.until('INVENTORY')['items'] == [{'item_id':'jade_amulet','price_paid':150}]
        a.send('MOVE', {'x':131,'z':110,'rotation':0.2})
        assert a.until('CHUNK_UNLOAD')['chunk_ids']
        stats = a.until('WORLD_STATS')
        assert stats['data_percent'] <= 10 and stats['loaded_chunks'] <= 9
    finally:
        a.close(); b.close()
    time.sleep(0.3)
    saved = request(GO, '/auth/login', {'login':one['player']['login'],'password':'integration123'})[1]
    assert saved['player']['balance'] == 350 and saved['inventory'][0]['item_id'] == 'jade_amulet'
    print('PASS: HTTP health/auth/errors, mock AI catalog/envelope, formant TTS, two WS players, movement/chat, turn IDs, quiz, purchase, chunk eviction, reconnect persistence')

if __name__ == '__main__':
    main()
