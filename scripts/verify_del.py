# -*- coding: utf-8 -*-
import json, urllib.request, time

def req(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request('http://localhost:5000' + url, data=data, method=method,
                               headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(r) as resp:
        return resp.status, json.loads(resp.read().decode())

# 造数据：两个会话各插一条公式
now = int(time.time() * 1000)
req('POST', '/api/formulas', {'items': [
    {'id': 'f_test_a', 'latex': '$F=-kx$', 'concept': '胡克定律', 'meaning': '弹簧回复力', 'sessionId': 'sess_A', 'createdAt': now},
    {'id': 'f_test_b', 'latex': '$E=mc^2$', 'concept': '质能方程', 'meaning': '质能等价', 'sessionId': 'sess_B', 'createdAt': now},
    {'id': 'f_test_c', 'latex': '$v=\\lambda f$', 'concept': '波速公式', 'meaning': '波速', 'sessionId': 'sess_A', 'createdAt': now},
]})
print('插入 3 条（sess_A×2 + sess_B×1）')

# 按会话删除 sess_A
st, res = req('DELETE', '/api/formulas?session_id=sess_A')
print('删除 sess_A:', res)

# 验证剩余
st, data = req('GET', '/api/formulas')
left = {k: v.get('sessionId') for k, v in data.items() if k.startswith('f_test_')}
print('剩余测试数据:', left)
assert left == {'f_test_b': 'sess_B'}, '按会话删除失败！'

# 无 session_id 时删除全部测试数据
st, res = req('DELETE', '/api/formulas?session_id=')
print('全删测试数据:', res)

st, data = req('GET', '/api/formulas')
left2 = [k for k in data if k.startswith('f_test_')]
print('最终测试数据残留:', left2)
assert not left2
print('\n按会话删除链路实测通过 ✓')
