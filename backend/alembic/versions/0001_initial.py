"""initial memory tables

Revision ID: 0001_initial
Revises:
Create Date: 2026-09-05
"""

from alembic import op
import sqlalchemy as sa

from app.models.memory import MemoryFileStatus, MemoryKind, MemoryStatus


revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "memories",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("kind", sa.Enum(MemoryKind, native_enum=False), nullable=False),
        sa.Column(
            "status",
            sa.Enum(MemoryStatus, native_enum=False),
            nullable=False,
            server_default=MemoryStatus.PENDING.value,
        ),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("location", sa.String(length=255), nullable=True),
        sa.Column("thumbnail_path", sa.String(length=512), nullable=True),
        sa.Column("duration_seconds", sa.Integer(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_memories_title"), "memories", ["title"])
    op.create_index(op.f("ix_memories_kind"), "memories", ["kind"])
    op.create_index(op.f("ix_memories_status"), "memories", ["status"])

    op.create_table(
        "memory_files",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("memory_id", sa.Uuid(), nullable=True),
        sa.Column("source", sa.String(length=32), nullable=False, server_default="baidupan"),
        sa.Column("remote_path", sa.String(length=1024), nullable=False),
        sa.Column("remote_id", sa.String(length=128), nullable=True),
        sa.Column("source_path", sa.String(length=1024), nullable=False),
        sa.Column("mime_type", sa.String(length=128), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column(
            "status",
            sa.Enum(MemoryFileStatus, native_enum=False),
            nullable=False,
            server_default=MemoryFileStatus.DISCOVERED.value,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["memory_id"], ["memories.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_memory_files_remote_path"), "memory_files", ["remote_path"])
    op.create_index(op.f("ix_memory_files_status"), "memory_files", ["status"])


def downgrade() -> None:
    op.drop_index(op.f("ix_memory_files_status"), table_name="memory_files")
    op.drop_index(op.f("ix_memory_files_remote_path"), table_name="memory_files")
    op.drop_table("memory_files")
    op.drop_index(op.f("ix_memories_status"), table_name="memories")
    op.drop_index(op.f("ix_memories_kind"), table_name="memories")
    op.drop_index(op.f("ix_memories_title"), table_name="memories")
    op.drop_table("memories")
