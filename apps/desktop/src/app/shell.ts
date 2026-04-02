import type { DesktopViewModel } from "../application/appController";

export function renderShell(container: HTMLElement, viewModel: DesktopViewModel): void {
  container.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <h1>RuCord</h1>
        <p>${viewModel.environmentLabel}</p>
      </aside>
      <main class="content">
        <section class="panel">
          <h2>Стартовый клиентский каркас</h2>
          <p>${viewModel.description}</p>
          <ul class="status-list">
            ${viewModel.capabilities.map((item) => `<li>${item}</li>`).join("")}
          </ul>
        </section>
      </main>
    </div>
  `;
}
