export const brand = {
  name: "Li&Media",
  shortName: "Media",
  slogan: "把照片和视频整理成可以回看的记忆",
  description: "基于百度网盘存储的公开回忆库。",
  nav: [
    { label: "首页", href: "/" },
    { label: "照片", href: "/?kind=photo" },
    { label: "视频", href: "/?kind=video" },
  ],
  footerLinks: [],
} as const;

export type Brand = typeof brand;
