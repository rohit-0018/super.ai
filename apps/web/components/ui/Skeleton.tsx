'use client';
import React from 'react';

interface SkeletonProps {
  className?: string;
  style?: React.CSSProperties;
  rounded?: 'sm' | 'md' | 'lg' | 'full';
  w?: number | string;
  h?: number | string;
}

const ROUND = { sm: 4, md: 6, lg: 10, full: 999 } as const;

export function Skeleton({ className = '', style, rounded = 'md', w, h }: SkeletonProps) {
  return (
    <div
      className={`skeleton ${className}`}
      style={{
        width: w,
        height: h,
        borderRadius: ROUND[rounded],
        ...style,
      }}
      aria-hidden
    />
  );
}

export function SkeletonText({
  lines = 3,
  width = ['100%', '92%', '68%'],
}: { lines?: number; width?: (number | string)[] }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} h={12} w={width[i % width.length] ?? '100%'} rounded="sm" />
      ))}
    </div>
  );
}

export function SkeletonCircle({ size = 36 }: { size?: number }) {
  return <Skeleton w={size} h={size} rounded="full" />;
}

export function SkeletonRow({ cols = 4 }: { cols?: number }) {
  return (
    <div className="flex items-center gap-4 py-3 border-t border-border">
      {Array.from({ length: cols }).map((_, i) => (
        <Skeleton key={i} h={12} w={i === 0 ? '22%' : '14%'} rounded="sm" />
      ))}
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="qwai-spinner inline-block"
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

export function InlineLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-[color:var(--text-3)]">
      <Spinner />
      <span>{label}…</span>
    </div>
  );
}
