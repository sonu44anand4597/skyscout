import { LayoutDashboard } from 'lucide-react';
import { Link } from 'react-router-dom';
import Button from '../ui/Button.jsx';
import ThemeToggle from '../layout/ThemeToggle.jsx';

export default function ResultsNavigation({ dashboardPath = '/dashboard' }) {
  return <nav aria-label="Flight results actions" className="mb-4 flex flex-wrap items-center justify-end gap-3">
    <Button as={Link} to={dashboardPath} className="inline-flex items-center gap-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600">
      <LayoutDashboard size={18} aria-hidden="true" /> Dashboard
    </Button>
    <ThemeToggle />
  </nav>;
}
