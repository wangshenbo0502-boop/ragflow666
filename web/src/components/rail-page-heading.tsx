import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

export function RailPageHeading({
  label,
  title,
  description,
  children,
}: {
  label: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="rail-page-heading">
      <div>
        <Link to="/home" className="rail-back-link">
          <ArrowLeft className="size-3.5" /> 返回工作台
        </Link>
        <p className="rail-eyebrow">{label}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </header>
  );
}
