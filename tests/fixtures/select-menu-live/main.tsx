import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SelectMenu } from '../../../src/components/SelectMenu';
import '../../../src/styles/index.css';

function Fixture() {
  const [value, setValue] = useState('all');
  const [count, setCount] = useState(80);
  useEffect(() => {
    // New records keep arriving while the filter dropdown is open.
    const timer = window.setInterval(() => setCount((current) => current + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const options = [
    { value: 'all', label: 'All models' },
    ...Array.from({ length: count }, (_, index) => ({ value: `m${index}`, label: `Model ${index}` })),
  ];
  return (
    <div style={{ padding: 40 }}>
      <SelectMenu value={value} onChange={setValue} ariaLabel="Filter" options={options} />
      <output>{count}</output>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
