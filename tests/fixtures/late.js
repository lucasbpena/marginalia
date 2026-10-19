// Simulates content rendered after load (SPAs, lazy sections).
setTimeout(() => {
  const p = document.createElement('p');
  p.id = 'p5';
  p.textContent = 'Late content appears after a delay and can be highlighted too.';
  document.getElementById('later').append(p);
}, 1500);
