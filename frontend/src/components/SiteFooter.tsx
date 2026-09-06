import { Link } from "react-router-dom";

import { brand } from "@/lib/brand";

export default function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer relative z-10">
      <div className="site-footer-inner">
        <span>
          © {year} {brand.copyrightHolder}
        </span>
        {brand.icp ? <span>{brand.icp}</span> : null}
        {brand.publicSecurityFiling ? <span>{brand.publicSecurityFiling}</span> : null}
        <span>{brand.description}</span>
        {brand.footerLinks.map((link) => (
          <a href={link.href} key={link.href}>
            {link.label}
          </a>
        ))}
        <Link to="/admin">{brand.copy.adminEntry}</Link>
      </div>
    </footer>
  );
}
