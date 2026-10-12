import { Link } from 'react-router';

type MobileMenuFooterProps = {
  onClose: () => void;
};

export function MobileMenuFooter({ onClose }: MobileMenuFooterProps) {
  return (
    <div className="shrink-0 border-t border-border-button px-4 py-4">
      <Link
        to="/user-setting/model"
        onClick={onClose}
        className="text-sm text-text-secondary"
      >
        模型与账户设置
      </Link>
    </div>
  );
}
