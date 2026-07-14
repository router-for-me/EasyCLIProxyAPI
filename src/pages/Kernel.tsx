import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export function KernelPage() {
  const [status, setStatus] = useState('检测中');

  useEffect(() => {
    invoke<string>('health_check')
      .then(setStatus)
      .catch(() => setStatus('需要在 Tauri 窗口中运行'));
  }, []);

  return (
    <section className="page">
      <h1>内核管理</h1>

      <div className="panel">
        <h2>运行状态</h2>
        <p>{status}</p>
      </div>
    </section>
  );
}
