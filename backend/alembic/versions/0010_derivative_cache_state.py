"""Add derivative cache state and public query indexes.

Revision ID: 0010_derivative_cache
Revises: 0009_browser_compatibility
Create Date: 2026-09-08
"""

from alembic import op
import sqlalchemy as sa


revision = "0010_derivative_cache"
down_revision = "0009_browser_compatibility"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    op.create_table(
        "memory_derivative_caches",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "memory_file_id",
            sa.Uuid(),
            sa.ForeignKey("memory_files.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("max_size", sa.Integer(), nullable=False),
        sa.Column("derivative_version", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("failure_kind", sa.String(length=64), nullable=True),
        sa.Column("output_path", sa.String(length=512), nullable=True),
        sa.Column("output_bytes", sa.Integer(), nullable=True),
        sa.Column("source_bytes", sa.Integer(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "memory_file_id",
            "max_size",
            "derivative_version",
            name="uq_memory_derivative_cache_identity",
        ),
    )
    op.create_index(
        "ix_memory_derivative_caches_lookup",
        "memory_derivative_caches",
        ["memory_file_id", "max_size", "derivative_version", "status"],
    )

    op.create_index(
        "ix_memories_public_order",
        "memories",
        ["status", "kind", sa.text("captured_at DESC NULLS LAST"), sa.text("id DESC")],
    )
    op.create_index(
        "ix_memory_files_public_visibility",
        "memory_files",
        [
            "memory_id",
            "source",
            "remote_state",
            "thumbnail_state",
            "stream_state",
            "browser_compatibility",
        ],
    )
    op.create_index(
        "ix_memories_title_trgm",
        "memories",
        ["title"],
        postgresql_using="gin",
        postgresql_ops={"title": "gin_trgm_ops"},
    )
    op.create_index(
        "ix_memories_description_trgm",
        "memories",
        ["description"],
        postgresql_using="gin",
        postgresql_ops={"description": "gin_trgm_ops"},
    )
    op.create_index(
        "ix_memories_location_trgm",
        "memories",
        ["location"],
        postgresql_using="gin",
        postgresql_ops={"location": "gin_trgm_ops"},
    )

    op.execute(
        r"""
        INSERT INTO memory_derivative_caches (
            id, memory_file_id, max_size, derivative_version, status,
            failure_kind, output_path, created_at, updated_at
        )
        SELECT gen_random_uuid(), f.id,
               substring(m.thumbnail_path from '/([0-9]+)\.webp$')::int,
               substring(m.thumbnail_path from '/([^/]+)/[0-9]+\.webp$'),
               'ready', NULL, m.thumbnail_path, now(), now()
        FROM memories m
        JOIN memory_files f ON f.memory_id = m.id
        WHERE f.source = 'baidupan'
          AND m.thumbnail_path ~ '/[0-9]+\.webp$'
        ON CONFLICT (memory_file_id, max_size, derivative_version) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_index("ix_memories_location_trgm", table_name="memories")
    op.drop_index("ix_memories_description_trgm", table_name="memories")
    op.drop_index("ix_memories_title_trgm", table_name="memories")
    op.drop_index("ix_memory_files_public_visibility", table_name="memory_files")
    op.drop_index("ix_memories_public_order", table_name="memories")
    op.drop_index(
        "ix_memory_derivative_caches_lookup", table_name="memory_derivative_caches"
    )
    op.drop_table("memory_derivative_caches")
