"""共享测试种子：给 MemoryFile 写入首页尺寸就绪派生缓存行。"""

from app.core.config import get_settings
from app.models.memory import DerivativeCacheStatus, MemoryDerivativeCache, MemoryFile
from app.services.thumbnail_preheat import HOME_PREHEAT_SIZE
from sqlalchemy.orm import Session


def seed_home_derivative(
    session: Session,
    memory_file: MemoryFile,
    *,
    max_size: int = HOME_PREHEAT_SIZE,
) -> None:
    """写入首页尺寸就绪派生缓存行（画布可见门槛的唯一权威口径）。"""

    session.add(
        MemoryDerivativeCache(
            memory_file_id=memory_file.id,
            max_size=max_size,
            derivative_version=get_settings().media_derivative_version,
            status=DerivativeCacheStatus.READY,
        )
    )
