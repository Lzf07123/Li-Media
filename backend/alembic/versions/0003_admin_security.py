"""add admin sessions and operation logs

Revision ID: 0003_admin_security
Revises: 0002_baidu_sync
Create Date: 2026-09-05
"""

from alembic import op
import sqlalchemy as sa


revision = "0003_admin_security"
down_revision = "0002_baidu_sync"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "admin_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("client_ip", sa.String(length=64), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_admin_sessions_token_hash"),
        "admin_sessions",
        ["token_hash"],
        unique=True,
    )
    op.create_index(
        op.f("ix_admin_sessions_expires_at"),
        "admin_sessions",
        ["expires_at"],
    )

    op.create_table(
        "admin_operation_logs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("action", sa.String(length=32), nullable=False),
        sa.Column("target_type", sa.String(length=32), nullable=True),
        sa.Column("target_id", sa.Uuid(), nullable=True),
        sa.Column("client_ip", sa.String(length=64), nullable=True),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["target_id"], ["memories.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_admin_operation_logs_action"),
        "admin_operation_logs",
        ["action"],
    )
    op.create_index(
        op.f("ix_admin_operation_logs_created_at"),
        "admin_operation_logs",
        ["created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_admin_operation_logs_created_at"),
        table_name="admin_operation_logs",
    )
    op.drop_index(
        op.f("ix_admin_operation_logs_action"),
        table_name="admin_operation_logs",
    )
    op.drop_table("admin_operation_logs")
    op.drop_index(
        op.f("ix_admin_sessions_expires_at"),
        table_name="admin_sessions",
    )
    op.drop_index(
        op.f("ix_admin_sessions_token_hash"),
        table_name="admin_sessions",
    )
    op.drop_table("admin_sessions")
