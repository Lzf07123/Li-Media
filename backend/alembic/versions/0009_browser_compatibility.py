"""Add persistent browser playback compatibility metadata."""

from alembic import op
import sqlalchemy as sa


revision = "0009_browser_compatibility"
down_revision = "0008_thumbnail_failure"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("memory_files") as batch:
        batch.add_column(
            sa.Column(
                "browser_compatibility",
                sa.String(length=32),
                nullable=False,
                server_default="unknown",
            )
        )
        batch.add_column(
            sa.Column(
                "browser_compatibility_version",
                sa.String(length=32),
                nullable=False,
                server_default="v1",
            )
        )
        batch.add_column(
            sa.Column("browser_format_summary", sa.JSON(), nullable=False, server_default="{}")
        )
        batch.add_column(sa.Column("browser_compatibility_error", sa.Text(), nullable=True))
        batch.add_column(
            sa.Column("browser_compatibility_checked_at", sa.DateTime(timezone=True))
        )
        batch.create_index(
            "ix_memory_files_browser_compatibility",
            ["browser_compatibility"],
        )

    op.create_table(
        "admin_background_jobs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("action", sa.String(length=32), nullable=False, index=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="queued", index=True),
        sa.Column("filter_snapshot", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("resource_ids", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("processed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("changed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("skipped", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("failed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_by_session", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("admin_background_jobs")
    with op.batch_alter_table("memory_files") as batch:
        batch.drop_index("ix_memory_files_browser_compatibility")
        batch.drop_column("browser_compatibility_checked_at")
        batch.drop_column("browser_compatibility_error")
        batch.drop_column("browser_format_summary")
        batch.drop_column("browser_compatibility_version")
        batch.drop_column("browser_compatibility")
