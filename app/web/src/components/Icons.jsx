const base = {
  width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
};

export const Icon = {
  dash: (p) => (<svg {...base} {...p}><path d="M3 13h6v8H3zM3 3h6v6H3zM15 3h6v8h-6zM15 15h6v6h-6z" /></svg>),
  notes: (p) => (<svg {...base} {...p}><path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" /><path d="M14 4v6h6M8 14h8M8 17h5" /></svg>),
  review: (p) => (<svg {...base} {...p}><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /><path d="M12 8v4l3 2" /></svg>),
  calendar: (p) => (<svg {...base} {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>),
  search: (p) => (<svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></svg>),
  sun: (p) => (<svg {...base} {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>),
  moon: (p) => (<svg {...base} {...p}><path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z" /></svg>),
  check: (p) => (<svg {...base} {...p}><path d="m4 12 5.5 5.5L20 7" /></svg>),
  again: (p) => (<svg {...base} {...p}><path d="M3 12a9 9 0 1 0 2.6-6.4" /><path d="M3 3v5h5" /></svg>),
  arrow: (p) => (<svg {...base} {...p}><path d="M5 12h14M13 6l6 6-6 6" /></svg>),
  back: (p) => (<svg {...base} {...p}><path d="M19 12H5M11 18l-6-6 6-6" /></svg>),
  plus: (p) => (<svg {...base} {...p}><path d="M12 5v14M5 12h14" /></svg>),
  x: (p) => (<svg {...base} {...p}><path d="M6 6l12 12M18 6 6 18" /></svg>),
  flame: (p) => (<svg {...base} {...p}><path d="M12 22a7 7 0 0 0 7-7c0-5-4-6-4-10 0 0-3 1.5-3 5 0 1.5-1 2-1.6 1.2C9.6 10 9.5 9 9.5 9S5 11 5 15a7 7 0 0 0 7 7z" /></svg>),
};
