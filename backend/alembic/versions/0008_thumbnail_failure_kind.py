"""add derivative failure classification to memory files

Revision ID: 0008_thumbnail_failure
Revises: 0007_remote_delete
Create Date: 2026-09-07
"""

from alembic import op
import sqlalchemy as sa


revision = "0008_thumbnail_failure"
down_revision = "0007_remote_delete"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("memory_files") as batch_op:
        batch_op.add_column(
            sa.Column("thumbnail_failure_kind", sa.String(length=64), nullable=True),
        )
        batch_op.create_index(
            op.f("ix_memory_files_thumbnail_failure_kind"),
            ["thumbnail_failure_kind"],
        )


def downgrade() -> None:
    with op.batch_alter_table("memory_files") as batch_op:
        batch_op.drop_index(op.f("ix_memory_files_thumbnail_failure_kind"))
        batch_op.drop_column("thumbnail_failure_kind")
