"""add remote scan task started timestamp default

Revision ID: 0006_remote_started
Revises: 0005_remote_scan
Create Date: 2026-09-05
"""

from alembic import op
import sqlalchemy as sa


revision = "0006_remote_started"
down_revision = "0005_remote_scan"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("remote_scan_tasks") as batch_op:
        batch_op.alter_column(
            "started_at",
            existing_type=sa.DateTime(timezone=True),
            existing_nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        )


def downgrade() -> None:
    with op.batch_alter_table("remote_scan_tasks") as batch_op:
        batch_op.alter_column(
            "started_at",
            existing_type=sa.DateTime(timezone=True),
            existing_nullable=False,
            server_default=None,
        )
