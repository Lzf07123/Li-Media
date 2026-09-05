"""add memory file content hash

Revision ID: 0004_content_hash
Revises: 0003_admin_security
Create Date: 2026-09-05
"""

from alembic import op
import sqlalchemy as sa


revision = "0004_content_hash"
down_revision = "0003_admin_security"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("memory_files") as batch_op:
        batch_op.add_column(
            sa.Column("content_hash", sa.String(length=64), nullable=True),
        )
        batch_op.create_index(
            op.f("ix_memory_files_content_hash"),
            ["content_hash"],
        )


def downgrade() -> None:
    with op.batch_alter_table("memory_files") as batch_op:
        batch_op.drop_index(op.f("ix_memory_files_content_hash"))
        batch_op.drop_column("content_hash")
