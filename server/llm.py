"""
llm.py — Qwen3.5-Flash 客户端（腾讯云 TokenHub, OpenAI 兼容）。
- function-calling + 流式（二者同用）
- 必须传 enable_thinking:false（否则默认思考慢到 ~14s）
- tool-loop：模型要调工具 → 本地查内存数据 → 回填 → 再流式生成
- key 从环境变量 TOKENHUB_API_KEY 读，绝不硬编码。

对外：async generator run_chat(...) 逐条 yield 事件 dict：
  {"type":"delta","text":..} / {"type":"cards","kind":..,"items":[..]} /
  {"type":"done"} / {"type":"error","message":..}
"""
from __future__ import annotations

import json
import logging
import os
from typing import AsyncIterator, Optional

from openai import AsyncOpenAI

from data import get_store
from tools import run_tool, tool_schemas

log = logging.getLogger("waic.llm")

BASE_URL = os.environ.get("TOKENHUB_BASE_URL", "https://tokenhub.tencentmaas.com/v1")
MODEL = os.environ.get("TOKENHUB_MODEL", "qwen3.5-flash")
MAX_TOOL_ROUNDS = 4

SYSTEM_PROMPT = """你是「WAIC 日程助手」，服务 2026 世界人工智能大会（WAIC 2026）的参会者。

【会期事实】WAIC 2026 会期为 7 月 17 日（第1天）到 7 月 20 日（第4天）。用户说的日期请据此换算成 day 参数（7/17=1, 7/18=2, 7/19=3, 7/20=4）。
三个片区：世博片区（世博中心、世博展览馆H1-H4）、张江片区（张江科学会堂）、西岸片区（西岸国际会展中心）。

【铁律】
1. 所有日程/展商/时间/地点等事实，必须调用工具查库获得，绝不能用你自己的知识回答（你并不知道 WAIC 的真实日程与日期，凭空回答会出错）。
2. 用简洁、可操作的中文回答；先给结论再给要点，避免大段废话。
3. 每条信息标注来源：工具返回 source_type=official 的标「官方」，unofficial 的标「非官方」，非官方信息补一句「以官方为准」。
4. 找不到就如实说没查到，并建议换个条件，不要编造。
5. 排行程/找路线/找展台时，优先用 plan_day / route_between / nearest_next / whats_on_now 等结构化工具。

工具返回的活动/展台会作为卡片展示给用户，你只需用文字做归纳、点评和建议，不必逐字复述所有字段。"""


_client: Optional[AsyncOpenAI] = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        key = os.environ.get("TOKENHUB_API_KEY")
        if not key:
            raise RuntimeError("环境变量 TOKENHUB_API_KEY 未设置")
        _client = AsyncOpenAI(base_url=BASE_URL, api_key=key, timeout=60.0)
    return _client


def _build_messages(user_messages: list[dict], my_schedule=None, profile=None) -> list[dict]:
    sys = SYSTEM_PROMPT
    profile = profile or {}
    interests = profile.get("interests") or []
    extra = []
    if interests:
        extra.append(f"用户兴趣：{', '.join(map(str, interests))}。排行程/推荐时优先考虑。")
    if my_schedule:
        extra.append(f"用户已加入日程的活动 id：{', '.join(map(str, my_schedule[:30]))}。避免与其时间冲突。")
    if extra:
        sys = sys + "\n\n【本次用户上下文】\n" + "\n".join(extra)
    msgs = [{"role": "system", "content": sys}]
    for m in user_messages:
        role = m.get("role", "user")
        if role not in ("user", "assistant", "system"):
            role = "user"
        msgs.append({"role": role, "content": m.get("content", "")})
    return msgs


async def _stream_once(client, messages):
    """发一次流式请求，返回 (assistant_content, tool_calls_list, text_deltas_generator 已在外部消费)。
    这里做成 async 生成器：先 yield ('delta', text)，最后 yield ('final', {content, tool_calls, finish})。"""
    stream = await client.chat.completions.create(
        model=MODEL,
        messages=messages,
        tools=tool_schemas(),
        tool_choice="auto",
        stream=True,
        max_tokens=1200,
        temperature=0.3,
        extra_body={"enable_thinking": False},  # 关键：关思考，延迟从 ~14s 降到 <1s
    )
    content_parts: list[str] = []
    tc_acc: dict[int, dict] = {}
    finish = None
    async for chunk in stream:
        if not chunk.choices:
            continue
        choice = chunk.choices[0]
        delta = choice.delta
        if getattr(delta, "content", None):
            content_parts.append(delta.content)
            yield ("delta", delta.content)
        if getattr(delta, "tool_calls", None):
            for tc in delta.tool_calls:
                slot = tc_acc.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
                if tc.id:
                    slot["id"] = tc.id
                if tc.function:
                    if tc.function.name:
                        slot["name"] = tc.function.name
                    if tc.function.arguments:
                        slot["arguments"] += tc.function.arguments
        if choice.finish_reason:
            finish = choice.finish_reason
    tool_calls = [tc_acc[i] for i in sorted(tc_acc)]
    yield ("final", {"content": "".join(content_parts), "tool_calls": tool_calls, "finish": finish})


async def run_chat(user_messages: list[dict], my_schedule=None, profile=None) -> AsyncIterator[dict]:
    store = get_store()
    try:
        client = _get_client()
    except Exception as e:  # noqa: BLE001
        log.warning("client init failed: %s", e)
        yield {"type": "error", "message": "AI 服务暂不可用，请稍后再试。"}
        return

    messages = _build_messages(user_messages, my_schedule, profile)

    try:
        for _round in range(MAX_TOOL_ROUNDS):
            assistant_content = ""
            tool_calls: list[dict] = []
            async for kind, payload in _stream_once(client, messages):
                if kind == "delta":
                    yield {"type": "delta", "text": payload}
                elif kind == "final":
                    assistant_content = payload["content"]
                    tool_calls = payload["tool_calls"]

            if not tool_calls:
                yield {"type": "done"}
                return

            # 记录 assistant 的 tool_calls 消息
            messages.append({
                "role": "assistant",
                "content": assistant_content or None,
                "tool_calls": [{
                    "id": tc["id"] or f"call_{i}",
                    "type": "function",
                    "function": {"name": tc["name"], "arguments": tc["arguments"] or "{}"},
                } for i, tc in enumerate(tool_calls)],
            })

            # 执行每个工具，回填结果 + 给前端发 cards
            for i, tc in enumerate(tool_calls):
                name = tc["name"]
                try:
                    args = json.loads(tc["arguments"] or "{}")
                except json.JSONDecodeError:
                    args = {}
                log.info("tool_call round=%d name=%s args=%s", _round, name, args)
                result = run_tool(store, name, args)
                cards = result.get("cards")
                if cards and cards.get("items"):
                    yield {"type": "cards", "kind": cards["kind"], "items": cards["items"]}
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"] or f"call_{i}",
                    "content": json.dumps(result.get("model", {}), ensure_ascii=False),
                })
            # 进入下一轮：模型看到工具结果后继续生成

        # 轮数用尽仍未收敛
        yield {"type": "done"}
    except Exception as e:  # noqa: BLE001
        log.exception("run_chat error: %s", e)
        yield {"type": "error", "message": "AI 生成出错，请稍后再试或换个问法。"}
