(() => {
  const win = nw.Window.get();
  let isMaximized = false;

  // Track window states accurately via NW.js window events
  win.on('maximize', () => { isMaximized = true; });
  win.on('restore', () => { isMaximized = false; });

  document.getElementById('btn-min').addEventListener('click', () => {
    win.minimize();
  });

  document.getElementById('btn-max').addEventListener('click', () => {
    if (isMaximized) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  document.getElementById('btn-close').addEventListener('click', () => {
    win.close();
  });
})();