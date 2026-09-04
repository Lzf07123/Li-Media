"""initial media tables

Revision ID: 0001_initial
Revises:
Create Date: 2026-09-04
"""

from alembic import op
import sqlalchemy as sa

from app.models.media import MediaFileStatus, MediaKind, MediaStatus


revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "media",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("original_title", sa.String(length=255), nullable=True),
        sa.Column("kind", sa.Enum(MediaKind, native_enum=False), nullable=False),
        sa.Column(
            "status",
            sa.Enum(MediaStatus, native_enum=False),
            nullable=False,
            server_default=MediaStatus.PENDING.value,
        ),
        sa.Column("year", sa.Integer(), nullable=True),
        sa.Column("overview", sa.Text(), nullable=False, server_default=""),
        sa.Column("rating", sa.Numeric(3, 1), nullable=True),
        sa.Column("poster_path", sa.String(length=512), nullable=True),
        sa.Column("backdrop_path", sa.String(length=512), nullable=True),
        sa.Column("tmdb_id", sa.String(length=32), nullable=True),
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
        sa.UniqueConstraint("tmdb_id"),
    )
    op.create_index(op.f("ix_media_title"), "media", ["title"])
    op.create_index(op.f("ix_media_status"), "media", ["status"])

    op.create_table(
        "media_files",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("media_id", sa.Uuid(), nullable=True),
        sa.Column("source", sa.String(length=32), nullable=False, server_default="baidupan"),
        sa.Column("remote_path", sa.String(length=1024), nullable=False),
        sa.Column("remote_id", sa.String(length=128), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column(
            "status",
            sa.Enum(MediaFileStatus, native_enum=False),
            nullable=False,
            server_default=MediaFileStatus.DISCOVERED.value,
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
        sa.ForeignKeyConstraint(["media_id"], ["media.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_media_files_remote_path"), "media_files", ["remote_path"])
    op.create_index(op.f("ix_media_files_status"), "media_files", ["status"])


def downgrade() -> None:
    op.drop_index(op.f("ix_media_files_status"), table_name="media_files")
    op.drop_index(op.f("ix_media_files_remote_path"), table_name="media_files")
    op.drop_table("media_files")
    op.drop_index(op.f("ix_media_status"), table_name="media")
    op.drop_index(op.f("ix_media_title"), table_name="media")
    op.drop_table("media")

