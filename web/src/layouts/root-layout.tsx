import { Outlet } from 'react-router';
import { Header } from './components/header';
import './railmind.css';

export function RootLayoutContainer({ children }: React.PropsWithChildren) {
  return (
    <div className="railmind-shell size-full min-w-0 grid grid-cols-1 grid-rows-[auto_minmax(0,1fr)]">
      <Header className="rail-header px-5 py-4" />

      <main className="size-full min-w-0 overflow-hidden">{children}</main>
    </div>
  );
}

export default function RootLayout() {
  return (
    <RootLayoutContainer>
      <Outlet />
    </RootLayoutContainer>
  );
}
