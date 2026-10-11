import React from 'react';
import mark from '../logo.svg';
import '../css/Brand.css';

export default function Brand({ inverse = false }) {
  return <span className={`brand${inverse ? ' brand-inverse' : ''}`}>
    <img src={mark} className="brand-mark" width="36" height="36" alt="" aria-hidden="true" draggable="false" />
    <span className="brand-wordmark">E-motel</span>
  </span>;
}
