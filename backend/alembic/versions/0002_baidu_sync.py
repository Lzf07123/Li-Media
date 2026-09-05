"""add Baidu Pan synchronization state

Revision ID: 0002_baidu_sync
Revises: 0001_initial
Create Date: 2026-09-05
"""

from alembic import op
import sqlalchemy as sa


revision = "0002_baidu_sync"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("memory_files") as batch_op:
        batch_op.add_column(
            sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        )
        batch_op.add_column(
            sa.Column("sync_error", sa.Text(), nullable=True),
        )
        batch_op.alter_column(
            "status",
            existing_type=sa.String(length=32),
            server_default="pending",
        )
    op.execute("UPDATE memory_files SET status = 'pending' WHERE status = 'discovered'")


def downgrade() -> None:
    with op.batch_alter_table("memory_files") as batch_op:
        batch_op.alter_column(
            "status",
            existing_type=sa.String(length=32),
            server_default="discovered",
        )
    op.execute("UPDATE memory_files SET status = 'discovered' WHERE status = 'pending'")
    op.execute("UPDATE memory_files SET status = 'discovered' WHERE status = 'syncing'")
    op.execute("UPDATE memory_files SET status = 'discovered' WHERE status = 'failed'")
    op.drop_column("memory_files", "sync_error")
    op.drop_column("memory_files", "last_synced_at")
