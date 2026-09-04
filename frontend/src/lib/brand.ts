export const brand = {
  name: "Li&Media",
  shortName: "Media",
  slogan: "把散乱文件整理成可浏览的媒体库",
  description: "基于百度网盘存储的公开媒体库。",
  nav: [
    { label: "首页", href: "/" },
    { label: "电影", href: "/?kind=movie" },
    { label: "剧集", href: "/?kind=tv" },
    { label: "动画", href: "/?kind=anime" },
  ],
  footerLinks: [],
} as const;

export type Brand = typeof brand;

