export function ConfigPanelPage() {
  return (
    <section className="page">
      <h1>配置面板</h1>

      <div className="panel">
        <h2>基础配置</h2>
        <label className="field">
          配置文件
          <input placeholder="待接入配置文件" />
        </label>
      </div>
    </section>
  );
}
