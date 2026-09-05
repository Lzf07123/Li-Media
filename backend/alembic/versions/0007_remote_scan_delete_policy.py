"""add async delete policy to remote scans

Revision ID: 0007_remote_delete
Revises: 0006_remote_started
Create Date: 2026-09-06
"""

from alembic import op
import sqlalchemy as sa


revision = "0007_remote_delete"
down_revision = "0006_remote_started"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("remote_scan_tasks") as batch_op:
        batch_op.add_column(
            sa.Column(
                "delete_missing",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )


def downgrade() -> None:
    with op.batch_alter_table("remote_scan_tasks") as batch_op:
        batch_op.drop_column("delete_missing")
