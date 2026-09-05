"""add remote-first scan index and observability states

Revision ID: 0005_remote_scan
Revises: 0004_content_hash
Create Date: 2026-09-05
"""

from alembic import op
import sqlalchemy as sa


revision = "0005_remote_scan"
down_revision = "0004_content_hash"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "remote_scan_tasks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("remote_dir", sa.String(length=1024), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("cursor", sa.Text(), nullable=True),
        sa.Column("max_depth", sa.Integer(), nullable=False),
        sa.Column("max_items", sa.Integer(), nullable=False),
        sa.Column("processed_items", sa.Integer(), nullable=False),
        sa.Column("scanned_files", sa.Integer(), nullable=False),
        sa.Column("scanned_directories", sa.Integer(), nullable=False),
        sa.Column("discovered", sa.Integer(), nullable=False),
        sa.Column("refreshed", sa.Integer(), nullable=False),
        sa.Column("skipped", sa.Integer(), nullable=False),
        sa.Column("failure_reason", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
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
    op.create_index(
        op.f("ix_remote_scan_tasks_status"),
        "remote_scan_tasks",
        ["status"],
    )

    with op.batch_alter_table("memory_files") as batch_op:
        batch_op.add_column(sa.Column("remote_md5", sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column("parent_path", sa.String(length=1024), nullable=False, server_default=""))
        batch_op.add_column(sa.Column("filename", sa.String(length=512), nullable=False, server_default=""))
        batch_op.add_column(sa.Column("extension", sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column("modified_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column("remote_state", sa.String(length=32), nullable=False, server_default="unverified"))
        batch_op.add_column(sa.Column("thumbnail_state", sa.String(length=32), nullable=False, server_default="missing"))
        batch_op.add_column(sa.Column("stream_state", sa.String(length=32), nullable=False, server_default="unavailable"))
        batch_op.add_column(sa.Column("raw_metadata_summary", sa.JSON(), nullable=False, server_default="{}"))
        batch_op.add_column(sa.Column("last_scan_task_id", sa.Uuid(), nullable=True))

    op.create_index(
        op.f("ix_memory_files_remote_md5"),
        "memory_files",
        ["remote_md5"],
    )
    op.create_index(
        op.f("ix_memory_files_remote_state"),
        "memory_files",
        ["remote_state"],
    )
    op.create_index(
        op.f("ix_memory_files_thumbnail_state"),
        "memory_files",
        ["thumbnail_state"],
    )
    op.create_index(
        op.f("ix_memory_files_stream_state"),
        "memory_files",
        ["stream_state"],
    )
    op.execute("""
        UPDATE memory_files
        SET filename = remote_path,
            parent_path = '',
            remote_state = CASE WHEN source_path <> '' THEN 'ready' ELSE 'unverified' END,
            thumbnail_state = CASE
                WHEN source_path <> '' AND EXISTS (
                    SELECT 1 FROM memories WHERE memories.id = memory_files.memory_id
                      AND memories.thumbnail_path IS NOT NULL
                ) THEN 'ready'
                ELSE 'missing'
            END,
            stream_state = CASE WHEN source_path <> '' THEN 'ready' ELSE 'unavailable' END
    """)


def downgrade() -> None:
    op.drop_index(op.f("ix_memory_files_stream_state"), table_name="memory_files")
    op.drop_index(op.f("ix_memory_files_thumbnail_state"), table_name="memory_files")
    op.drop_index(op.f("ix_memory_files_remote_state"), table_name="memory_files")
    op.drop_index(op.f("ix_memory_files_remote_md5"), table_name="memory_files")
    with op.batch_alter_table("memory_files") as batch_op:
        batch_op.drop_column("last_scan_task_id")
        batch_op.drop_column("raw_metadata_summary")
        batch_op.drop_column("stream_state")
        batch_op.drop_column("thumbnail_state")
        batch_op.drop_column("remote_state")
        batch_op.drop_column("modified_at")
        batch_op.drop_column("extension")
        batch_op.drop_column("filename")
        batch_op.drop_column("parent_path")
        batch_op.drop_column("remote_md5")
    op.drop_index(op.f("ix_remote_scan_tasks_status"), table_name="remote_scan_tasks")
    op.drop_table("remote_scan_tasks")
