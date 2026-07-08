"""
PhyMathia 数据库模型定义
表：sessions, messages, knowledge_items, kv_store
"""

from sqlalchemy import BigInteger, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, JSON, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from typing import Optional
from datetime import datetime
from coze_coding_dev_sdk.database import Base


class Session(Base):
    """会话表"""
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(128), primary_key=True, comment="会话ID")
    title: Mapped[str] = mapped_column(String(256), nullable=False, server_default="新对话", comment="会话标题")
    icon: Mapped[str] = mapped_column(String(64), nullable=False, server_default="", comment="会话图标")
    coze_session_id: Mapped[str] = mapped_column(String(256), nullable=False, server_default="", comment="Coze会话ID")
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False, comment="创建时间戳(ms)")
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False, comment="更新时间戳(ms)")

    __table_args__ = (
        Index("sessions_updated_at_idx", "updated_at"),
    )


class Message(Base):
    """消息表"""
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(String(128), ForeignKey("sessions.id"), nullable=False, comment="所属会话ID")
    msg_index: Mapped[int] = mapped_column(Integer, nullable=False, comment="消息序号")
    msg_data: Mapped[str] = mapped_column(Text, nullable=False, comment="消息JSON数据")

    __table_args__ = (
        Index("messages_session_id_idx", "session_id"),
    )


class KnowledgeItem(Base):
    """知识条目表"""
    __tablename__ = "knowledge_items"

    id: Mapped[str] = mapped_column(String(128), primary_key=True, comment="条目ID")
    session_id: Mapped[str] = mapped_column(String(128), ForeignKey("sessions.id"), nullable=False, comment="所属会话ID")
    item_data: Mapped[str] = mapped_column(Text, nullable=False, comment="条目JSON数据")

    __table_args__ = (
        Index("knowledge_items_session_id_idx", "session_id"),
    )


class KvStore(Base):
    """键值存储表"""
    __tablename__ = "kv_store"

    key: Mapped[str] = mapped_column(String(256), primary_key=True, comment="键")
    value: Mapped[str] = mapped_column(Text, nullable=False, comment="值")
