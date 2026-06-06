/**
 * Copyright 2025 Aman
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 */

document.addEventListener("DOMContentLoaded", () => {
  // Only execute the polling engine if we are on the main Dashboard
  const container = document.getElementById('transfers-container');
  const card = document.getElementById('active-transfers-card');
  
  if (!container || !card) return;

  async function updateProgress() {
    try {
      const response = await fetch('/api/progress');
      if (!response.ok) return;
      
      const data = await response.json();
      
      // Hide the active transfer window if there are no downloads
      if (!data.tasks || data.tasks.length === 0) {
        card.classList.add('hidden');
        return;
      }
      
      // Reveal the window and clear old data
      card.classList.remove('hidden');
      container.innerHTML = '';
      
      // Inject the live progress bars
      data.tasks.forEach(task => {
        const taskEl = document.createElement('div');
        taskEl.className = "space-y-1.5 bg-slate-950/40 p-3 rounded-lg border border-slate-900";
        
        taskEl.innerHTML = `
          <div class="flex justify-between items-center text-xs font-mono">
            <span class="text-slate-400 font-semibold">Pipe ID: ${task.file_id}</span>
            <span class="text-amber-400 font-bold">${task.status} (${task.progress}%)</span>
          </div>
          <div class="bg-slate-900 border border-slate-800 rounded-full h-2.5 w-full overflow-hidden">
            <div class="bg-amber-500 h-full w-[${task.progress}%] rounded-full transition-all duration-300 ease-in-out" style="width: ${task.progress}%"></div>
          </div>
        `;
        container.appendChild(taskEl);
      });
    } catch (err) {
      console.error('Telemetry buffer tracking error:', err);
    }
  }

  // Poll the API route every 2 seconds
  setInterval(updateProgress, 2000);
  
  // Initial manual invocation when the dashboard loads
  updateProgress();
});
