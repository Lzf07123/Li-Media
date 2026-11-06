"""关键字搜索的小工具：LIKE 通配符转义。"""

_ESCAPES = str.maketrans(
    {
        "\\": "\\\\",
        "%": "\\%",
        "_": "\\_",
    }
)


def escape_like(keyword: str) -> str:
    """转义 LIKE/ilike 通配符，让用户输入按字面量匹配。

    参数化已保证无 SQL 注入；这里进一步防止 `%`/`_` 被当作通配符
    造成的语义注入与全表扫描放大。配合 ``ilike(..., escape="\\")`` 使用。
    """

    return keyword.translate(_ESCAPES)
