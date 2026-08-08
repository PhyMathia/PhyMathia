"""离线 Mock 回答与 SSE 流。"""

import asyncio
import time

MOCK_ANSWER = r"""<physics>
## 🔬 物理视角

简谐运动是物体在回复力 <formula>F=-kx</formula> 作用下的周期性运动。想象一个弹簧振子：当你拉长弹簧后松手，物体会在平衡位置附近来回振荡。

关键物理量：
- **振幅 A**：最大偏离距离
- **周期 T**：完成一次完整振动的时间，<formula>T = 2\pi\sqrt{\frac{m}{k}}</formula>
- **频率 f**：单位时间内振动次数，<formula>f = 1/T</formula>

在振动过程中，动能和势能不断相互转换，但总机械能守恒：
<formula>E_{\text{total}} = \frac{1}{2}kA^2</formula>

</physics>
<math>
## 📐 数学视角

简谐运动的位移随时间变化满足正弦函数：
<formula>x(t) = A\cos(\omega t + \varphi_0)</formula>

其中角频率 <formula>\omega = \sqrt{\frac{k}{m}}</formula>，φ₀ 是初相位。

速度与加速度：
<formula>v(t) = -A\omega\sin(\omega t + \varphi_0)</formula>
<formula>a(t) = -A\omega^2\cos(\omega t + \varphi_0) = -\omega^2 x(t)</formula>

可见加速度始终与位移方向相反、大小成正比，这正是简谐运动的数学本质——二阶线性微分方程：
<formula>\frac{d^2x}{dt^2} + \omega^2 x = 0</formula>

</math>
<graph>
## 🧠 知识图谱

```mermaid
graph TD
    A[简谐运动] --> B[物理特征]
    A --> C[数学描述]
    B --> D[回复力 F=-kx]
    B --> E[能量守恒]
    B --> F[周期 T=2π√(m/k)]
    C --> G[正弦/余弦函数]
    C --> H[微分方程]
    C --> I[相空间椭圆]
    G --> J[x=Acos(ωt+φ₀)]
    H --> K[ẍ+ω²x=0]
```

</graph>
<viz>
## 🎮 交互探索
```html
__PHYMATHIA_VISUALIZATION__
```
</viz>
<extend>
## 💡 延伸思考

### 苏格拉底追问
1. [基础] 为什么阻尼振动中的能量会逐渐耗散？可以从哪个物理机制解释？
2. [进阶] 如果加入线性阻尼项 c(dx/dt)，简谐运动的微分方程会变成什么形式？
3. [拓展] 复数和相量如何简化简谐运动的叠加分析？

### 进阶学习方向
1. 阻尼振荡器与品质因数
2. 受迫振动与共振曲线
3. 傅里叶分析在振动分解中的应用
</extend>

<summary>简谐运动是回复力与位移成正比的周期运动，能量在动能与势能间周期转换</summary>"""


MOCK_SOCRATIC_ANSWER_1 = r"""你的推理方向是对的。阻尼会持续消耗机械能，所以振幅会衰减。

那如果加入线性阻尼项 <formula>c\dot{x}</formula>，微分方程会变成什么形式？

<socratic_meta correct="correct" done="false" />"""


MOCK_SOCRATIC_ANSWER_2 = r"""你已经连续答对两次，这段追问就到这里。

小结：阻尼振动通过耗散机械能降低振幅，数学上用含 <formula>c\dot{x}</formula> 的二阶常系数线性微分方程描述。

<summary>阻尼振动通过耗散机械能降低振幅，由含阻尼项的常微分方程描述</summary>
<socratic_meta correct="correct" done="true" />"""


MOCK_HTML_VISUALIZATION = r"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
body{margin:16px;background:#0f142d;color:#f0f4f8;font-family:sans-serif;display:flex;flex-direction:column;align-items:center}
h2{color:#4a9eff;margin:0 0 10px;font-size:18px}
canvas{border:1px solid rgba(74,158,255,0.3);border-radius:8px;background:rgba(10,14,30,0.5);max-width:100%}
.controls{display:flex;gap:16px;margin:12px 0;flex-wrap:wrap;justify-content:center}
.slider-group{display:flex;flex-direction:column;align-items:center;gap:2px}
.slider-group label{font-size:12px;color:#a0b0d0}
.slider-group input{width:100px}
.info{font-size:13px;color:#a0b0d0;margin-top:8px;text-align:center}
</style></head>
<body>
<h2>&#x1f52c; 简谐运动可视化</h2>
<canvas id="c" width="560" height="160"></canvas>
<div class="controls">
<div class="slider-group"><label>振幅 A</label><input type="range" id="aA" min="20" max="80" value="60"></div>
<div class="slider-group"><label>角频率 &#x3c9;</label><input type="range" id="aW" min="1" max="5" value="2" step="0.1"></div>
<div class="slider-group"><label>速度</label><input type="range" id="aSp" min="0.5" max="3" value="1" step="0.1"></div>
</div>
<div class="info" id="info">x = 60 cos(2.0 t)</div>
<script>
(function(){function r(){
var c=document.getElementById('c'),ctx=c.getContext('2d');
var A=parseFloat(document.getElementById('aA').value)||60;
var w=parseFloat(document.getElementById('aW').value)||2;
var sp=parseFloat(document.getElementById('aSp').value)||1;
t=(t||0)+0.02*sp;var x=A*Math.cos(w*t);var cx=280+x;
ctx.clearRect(0,0,560,160);
ctx.fillStyle='rgba(74,158,255,0.05)';ctx.fillRect(0,0,560,160);
ctx.strokeStyle='rgba(74,158,255,0.15)';ctx.setLineDash([4,4]);
ctx.beginPath();ctx.moveTo(280,30);ctx.lineTo(280,130);ctx.stroke();
ctx.setLineDash([]);
ctx.fillStyle='#4a9eff';ctx.beginPath();ctx.arc(cx,80,8,0,Math.PI*2);ctx.fill();
ctx.fillStyle='rgba(74,158,255,0.25)';ctx.beginPath();ctx.arc(cx,80,14,0,Math.PI*2);ctx.fill();
ctx.strokeStyle='#4a9eff';ctx.beginPath();ctx.moveTo(280,80);ctx.lineTo(cx,80);ctx.stroke();
var v=-A*w*Math.sin(w*t);
document.getElementById('info').textContent='x='+x.toFixed(1)+'  '+'v='+v.toFixed(1);
requestAnimationFrame(r)}
document.getElementById('aA').addEventListener('input',r);
document.getElementById('aW').addEventListener('input',r);
document.getElementById('aSp').addEventListener('input',r);
var t=0;r()})();
</script>
</body></html>"""


async def _mock_stream_openai(content: str = MOCK_ANSWER, include_html: bool = True):
    """生成 OpenAI 格式的 mock SSE 流，模拟逐字输出"""
    # 首个空 chunk（触发前端进度显示）
    yield {
        "id": "phymathia-chat",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "phymathia-mock",
        "progress": 2,
        "choices": [{"index": 0, "delta": {"content": ""}, "finish_reason": None}],
    }
    await asyncio.sleep(0.3)

    if include_html and "__PHYMATHIA_VISUALIZATION__" in content:
        content = content.replace("__PHYMATHIA_VISUALIZATION__", MOCK_HTML_VISUALIZATION)

    # 逐 chunk 发送 markdown 内容
    chunk_size = 4
    total_chunks = max(1, (len(content) + chunk_size - 1) // chunk_size)
    for index, i in enumerate(range(0, len(content), chunk_size)):
        chunk = content[i : i + chunk_size]
        yield {
            "id": "phymathia-chat",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": "phymathia-mock",
            "progress": min(85, 3 + round((index + 1) / total_chunks * 72)),
            "choices": [{"index": 0, "delta": {"content": chunk}, "finish_reason": None}],
        }
        await asyncio.sleep(0.015)

    await asyncio.sleep(0.2)

    # 结束标记
    yield {
        "id": "phymathia-chat",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "phymathia-mock",
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
    }



__all__ = [
    "MOCK_ANSWER", "MOCK_SOCRATIC_ANSWER_1", "MOCK_SOCRATIC_ANSWER_2",
    "MOCK_HTML_VISUALIZATION", "_mock_stream_openai",
]
