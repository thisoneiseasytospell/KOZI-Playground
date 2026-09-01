(function () {
  'use strict';

  const encoder = new TextEncoder();
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function write16(view, offset, value) { view.setUint16(offset, value, true); }
  function write32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

  function zipStore(files) {
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const locals = [];
    const centrals = [];
    let localOffset = 0;

    for (const [name, source] of Object.entries(files)) {
      const nameBytes = encoder.encode(name);
      const data = source instanceof Uint8Array ? source : encoder.encode(source);
      const checksum = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length + data.length);
      const lv = new DataView(local.buffer);
      write32(lv, 0, 0x04034b50);
      write16(lv, 4, 20);
      write16(lv, 6, 0x0800);
      write16(lv, 8, 0);
      write16(lv, 10, dosTime);
      write16(lv, 12, dosDate);
      write32(lv, 14, checksum);
      write32(lv, 18, data.length);
      write32(lv, 22, data.length);
      write16(lv, 26, nameBytes.length);
      write16(lv, 28, 0);
      local.set(nameBytes, 30);
      local.set(data, 30 + nameBytes.length);
      locals.push(local);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      write32(cv, 0, 0x02014b50);
      write16(cv, 4, 20);
      write16(cv, 6, 20);
      write16(cv, 8, 0x0800);
      write16(cv, 10, 0);
      write16(cv, 12, dosTime);
      write16(cv, 14, dosDate);
      write32(cv, 16, checksum);
      write32(cv, 20, data.length);
      write32(cv, 24, data.length);
      write16(cv, 28, nameBytes.length);
      write16(cv, 30, 0);
      write16(cv, 32, 0);
      write16(cv, 34, 0);
      write16(cv, 36, 0);
      write32(cv, 38, 0);
      write32(cv, 42, localOffset);
      central.set(nameBytes, 46);
      centrals.push(central);
      localOffset += local.length;
    }

    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    write32(ev, 0, 0x06054b50);
    write16(ev, 4, 0);
    write16(ev, 6, 0);
    write16(ev, 8, centrals.length);
    write16(ev, 10, centrals.length);
    write32(ev, 12, centralSize);
    write32(ev, 16, localOffset);
    write16(ev, 20, 0);

    const total = localOffset + centralSize + end.length;
    const zip = new Uint8Array(total);
    let offset = 0;
    for (const part of [...locals, ...centrals, end]) {
      zip.set(part, offset);
      offset += part.length;
    }
    return zip;
  }

  function createAvatar(container, options = {}) {
    const config = {
      ...DEFAULT_CONFIG,
      ...options,
      dimensions: { ...DEFAULT_CONFIG.dimensions, ...(options.dimensions || {}) },
      rotation: { ...DEFAULT_CONFIG.rotation, ...(options.rotation || {}) },
      eyes: {
        ...DEFAULT_CONFIG.eyes,
        ...(options.eyes || {}),
        left: { ...DEFAULT_CONFIG.eyes.left, ...(options.eyes?.left || {}) },
        right: { ...DEFAULT_CONFIG.eyes.right, ...(options.eyes?.right || {}) },
      },
      surface: { ...DEFAULT_CONFIG.surface, ...(options.surface || {}) },
      motion: { ...DEFAULT_CONFIG.motion, ...(options.motion || {}) },
      orbit: { ...DEFAULT_CONFIG.orbit, ...(options.orbit || {}) },
      planeMesh: { ...(DEFAULT_CONFIG.planeMesh || {}), ...(options.planeMesh || {}) },
    };
    const TAU = Math.PI * 2;
    const D2R = Math.PI / 180;
    const FACE_REACH = 1.06;   // how far out on a flat face a mark may sit
    const EYE_SHAPE_HANDLE_COUNT = 8;
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const norm = v => {
      const length = Math.hypot(v.x, v.y, v.z) || 1;
      return { x: v.x / length, y: v.y / length, z: v.z / length };
    };
    const apply = (m, v) => ({
      x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
      y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
      z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
    });
    const multiply = (a, b) => {
      const out = new Array(9);
      for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++)
        out[row * 3 + column] = a[row * 3] * b[column] + a[row * 3 + 1] * b[column + 3] + a[row * 3 + 2] * b[column + 6];
      return out;
    };
    const rotationMatrix = (rx, ry, rz) => {
      const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
      return multiply([cz,-sz,0, sz,cz,0, 0,0,1], multiply([cy,0,sy, 0,1,0, -sy,0,cy], [1,0,0, 0,cx,-sx, 0,sx,cx]));
    };
    const hull = points => {
      const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
      if (sorted.length < 3) return sorted;
      const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
      const lower = [], upper = [];
      for (const point of sorted) {
        while (lower.length > 1 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
        lower.push(point);
      }
      for (let index = sorted.length - 1; index >= 0; index--) {
        const point = sorted[index];
        while (upper.length > 1 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
        upper.push(point);
      }
      lower.pop(); upper.pop();
      return lower.concat(upper);
    };
    const polyPath = points => points.length ? `M${points.map(point => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join('L')}Z` : '';
    const smoothPath = points => {
      if (points.length < 3) return '';
      let d = `M${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
      for (let index = 0; index < points.length; index++) {
        const p0 = points[(index - 1 + points.length) % points.length];
        const p1 = points[index];
        const p2 = points[(index + 1) % points.length];
        const p3 = points[(index + 2) % points.length];
        d += `C${(p1.x + (p2.x - p0.x) / 6).toFixed(2)} ${(p1.y + (p2.y - p0.y) / 6).toFixed(2)} ${(p2.x - (p3.x - p1.x) / 6).toFixed(2)} ${(p2.y - (p3.y - p1.y) / 6).toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
      }
      return d + 'Z';
    };
    const ellipsePath = (cx, cy, rx, ry, angle) => {
      const degrees = angle / D2R;
      const ux = Math.cos(angle) * rx, uy = Math.sin(angle) * rx;
      return `M${(cx + ux).toFixed(2)} ${(cy + uy).toFixed(2)}A${rx.toFixed(2)} ${ry.toFixed(2)} ${degrees.toFixed(2)} 1 1 ${(cx - ux).toFixed(2)} ${(cy - uy).toFixed(2)}A${rx.toFixed(2)} ${ry.toFixed(2)} ${degrees.toFixed(2)} 1 1 ${(cx + ux).toFixed(2)} ${(cy + uy).toFixed(2)}Z`;
    };
    const ellipsoid = (m, a, b, c) => {
      const r1 = [m[0] * a, m[1] * b, m[2] * c];
      const r2 = [-m[3] * a, -m[4] * b, -m[5] * c];
      const s00 = r1.reduce((sum, value) => sum + value * value, 0);
      const s11 = r2.reduce((sum, value) => sum + value * value, 0);
      const s01 = r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2];
      const mid = (s00 + s11) / 2;
      const difference = Math.sqrt(Math.max(0, ((s00 - s11) / 2) ** 2 + s01 * s01));
      return {
        rx: Math.sqrt(Math.max(0, mid + difference)),
        ry: Math.sqrt(Math.max(0, mid - difference)),
        angle: difference < 1e-5 * mid ? 0 : 0.5 * Math.atan2(2 * s01, s00 - s11),
      };
    };
    const eyeHandleAnchor = (width, height, index) => {
      width = Math.max(4, width); height = Math.max(4, height);
      const swap = width > height;
      const W = swap ? height : width, H = swap ? width : height;
      const radius = W / 2, side = Math.max(0, H / 2 - radius);
      const target = -Math.PI / 2 + index / EYE_SHAPE_HANDLE_COUNT * TAU;
      const ray = { x:width / 2 * Math.cos(target), y:height / 2 * Math.sin(target) };
      const d = swap ? { x:ray.y, y:-ray.x } : ray;
      const flankY = Math.abs(d.x) > 1e-9 ? radius / Math.abs(d.x) * d.y : Infinity;
      let point;
      if (Math.abs(flankY) <= side) point = { x:Math.sign(d.x) * radius, y:flankY };
      else {
        const cy = d.y >= 0 ? side : -side;
        const dd = d.x * d.x + d.y * d.y, dc = d.y * cy;
        const u = (dc + Math.sqrt(Math.max(0, dc * dc - dd * (cy * cy - radius * radius)))) / dd;
        point = { x:u * d.x, y:u * d.y };
      }
      return swap ? { x:-point.y, y:point.x } : point;
    };
    // A traced outline is a closed cubic path in fractions of the shape's box.
    // The surface frame is affine, so it can be written straight out as curves.
    const isTraced = outline => outline?.v === 2 && Array.isArray(outline.nodes);
    const tracedNodes = (outline, width, height, tilt) => {
      const ct = Math.cos(tilt), st = Math.sin(tilt);
      const put = (x, y) => tilt ? { x:x * ct - y * st, y:x * st + y * ct } : { x, y };
      return outline.nodes.map(node => ({
        p:put(node.x * width, node.y * height),
        out:put(node.ox * width, node.oy * height),
        in:put(node.ix * width, node.iy * height),
      }));
    };
    const cubicPath = (nodes, project) => {
      const total = nodes.length;
      const start = project(nodes[0].p);
      let d = `M${start.x.toFixed(2)} ${start.y.toFixed(2)}`;
      for (let index = 0; index < total; index++) {
        const a = nodes[index], b = nodes[(index + 1) % total];
        const c1 = project({ x:a.p.x + a.out.x, y:a.p.y + a.out.y });
        const c2 = project({ x:b.p.x + b.in.x, y:b.p.y + b.in.y });
        const end = project(b.p);
        d += `C${c1.x.toFixed(2)} ${c1.y.toFixed(2)} ${c2.x.toFixed(2)} ${c2.y.toFixed(2)} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
      }
      return d + 'Z';
    };
    const eyePoints = (width, height, tilt, lid = 0, bend = 0, count = 96, outline = null) => {
      width = Math.max(4, width); height = Math.max(4, height);
      const swap = width > height;
      const W = swap ? height : width, H = swap ? width : height;
      const radius = W / 2, side = Math.max(0, H / 2 - radius);
      const arc = Math.PI * radius, total = 2 * arc + 4 * side || 1;
      const points = [];
      for (let index = 0; index < count; index++) {
        let progress = index / count * total, x, y;
        if (progress < 2 * side) { x = radius; y = -side + progress; }
        else if ((progress -= 2 * side) < arc) { const t = progress / arc * Math.PI; x = radius * Math.cos(t); y = side + radius * Math.sin(t); }
        else if ((progress -= arc) < 2 * side) { x = -radius; y = side - progress; }
        else { progress -= 2 * side; const t = Math.PI + progress / arc * Math.PI; x = radius * Math.cos(t); y = -side + radius * Math.sin(t); }
        if (swap) { const previousX = x; x = -y; y = previousX; }
        points.push({ x, y });
      }
      const halfWidth = width / 2, halfHeight = height / 2;
      const tangentOf = (point, xKey, yKey) =>
        point?.[xKey] == null || point?.[yKey] == null ? null : { x:point[xKey] * width, y:point[yKey] * height };
      const isCustom = outline?.some?.(point =>
        point?.x || point?.y || ['ox', 'oy', 'ix', 'iy'].some(key => point?.[key] != null));
      if (isTraced(outline)) {
        const nodes = tracedNodes(outline, width, height, 0);
        points.splice(0, points.length, ...Array.from({ length:count }, (_, sampleIndex) => {
          const progress = sampleIndex / count * nodes.length;
          const segment = Math.floor(progress) % nodes.length;
          const t = progress - Math.floor(progress);
          const a = nodes[segment], b = nodes[(segment + 1) % nodes.length];
          const u = 1 - t, k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
          return {
            x:k0 * a.p.x + k1 * (a.p.x + a.out.x) + k2 * (b.p.x + b.in.x) + k3 * b.p.x,
            y:k0 * a.p.y + k1 * (a.p.y + a.out.y) + k2 * (b.p.y + b.in.y) + k3 * b.p.y,
          };
        }));
      } else if (outline?.length === EYE_SHAPE_HANDLE_COUNT && isCustom) {
        const nodes = Array.from({ length:EYE_SHAPE_HANDLE_COUNT }, (_, handleIndex) => {
          const anchor = eyeHandleAnchor(width, height, handleIndex);
          const point = outline[handleIndex];
          return {
            p:{
              x:anchor.x + (Number(point?.x) || 0) * width,
              y:anchor.y + (Number(point?.y) || 0) * height,
            },
            out:tangentOf(point, 'ox', 'oy'),
            in:tangentOf(point, 'ix', 'iy'),
          };
        });
        // a uniform Catmull-Rom segment is the Bezier with controls +/-(neighbour)/6,
        // so points left on auto keep the exact curve the editor drew before tangents
        const total = nodes.length, outs = [], ins = [];
        for (let nodeIndex = 0; nodeIndex < total; nodeIndex++) {
          const previous = nodes[(nodeIndex + total - 1) % total].p, next = nodes[(nodeIndex + 1) % total].p;
          const auto = { x:(next.x - previous.x) / 6, y:(next.y - previous.y) / 6 };
          outs.push(nodes[nodeIndex].out || auto);
          ins.push(nodes[nodeIndex].in || { x:-auto.x, y:-auto.y });
        }
        points.splice(0, points.length, ...Array.from({ length:count }, (_, sampleIndex) => {
          const progress = sampleIndex / count * total;
          const segment = Math.floor(progress) % total;
          const t = progress - Math.floor(progress);
          const start = nodes[segment].p, end = nodes[(segment + 1) % total].p;
          const c1 = outs[segment], c2 = ins[(segment + 1) % total];
          const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
          return {
            x:a * start.x + b * (start.x + c1.x) + c * (end.x + c2.x) + d * end.x,
            y:a * start.y + b * (start.y + c1.y) + c * (end.y + c2.y) + d * end.y,
          };
        }));
      }
      const effectiveBend = clamp(bend, -1.2, 1.2) * clamp((height - 5) / 10, 0, 1);
      const top = -halfHeight + clamp(lid, 0, 0.92) * 1.55 * halfHeight;
      const ct = Math.cos(tilt), st = Math.sin(tilt);
      for (const point of points) {
        if (effectiveBend) point.y += effectiveBend * halfHeight * 0.9 * ((point.x / halfWidth) ** 2 - 0.5);
        if (tilt) { const x = point.x, y = point.y; point.x = x * ct - y * st; point.y = x * st + y * ct; }
        if (lid > 0) point.y = Math.max(point.y, top);
      }
      return points;
    };

    const host = document.createElement('div');
    host.className = 'kozi-avatar';
    const shadow = host.attachShadow({ mode: 'open' });
    const colors = config.surface.colors?.length ? config.surface.colors : ['#3f19c8', '#ffffff'];
    const stops = colors.map((color, index) => `<stop offset="${index / Math.max(1, colors.length - 1) * 100}%" stop-color="${color}"/>`).join('');
    shadow.innerHTML = `<style>
      :host{display:block;width:100%;height:100%;min-width:120px;min-height:120px;contain:layout paint style}
      svg{display:block;width:100%;height:100%;overflow:visible;touch-action:none;user-select:none}
      .head{fill:${config.surface.mode === 'flat' ? colors[0] : 'url(#avatar-surface)'}}
      .eye{fill:${config.eyeColor || '#0e0e14'};shape-rendering:geometricPrecision}
    </style><svg viewBox="0 0 560 560" role="img" aria-label="Animated 2D/3D avatar">
      <defs><linearGradient id="avatar-surface" x1="0" y1="0" x2="1" y2="1">${stops}</linearGradient></defs>
      <path class="head"></path><path class="eye eye-left"></path><path class="eye eye-right"></path><path class="eye mouth"></path>
    </svg>`;
    container.appendChild(host);
    const svg = shadow.querySelector('svg');
    const head = shadow.querySelector('.head');
    const leftEye = shadow.querySelector('.eye-left');
    const rightEye = shadow.querySelector('.eye-right');
    const mouth = shadow.querySelector('.mouth');
    const gradient = shadow.querySelector('#avatar-surface');
    let width = 560, height = 560, animationFrame = 0, previousTime = performance.now();
    let elapsed = 0, orbitAngle = 0, blink = 0, blinkTarget = 0, blinkTimer = 0;
    let pointerX = 0, pointerY = 0, drag = null;
    const rotation = { ...config.rotation };
    const resizeObserver = new ResizeObserver(entries => {
      const rect = entries[0].contentRect;
      width = Math.max(120, rect.width); height = Math.max(120, rect.height);
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    });
    resizeObserver.observe(host);

    function projectFactory(matrix, scale, centerX, centerY) {
      return value => {
        const projected = apply(matrix, value);
        return { x: centerX + projected.x * scale, y: centerY - projected.y * scale };
      };
    }
    function headPath(matrix, project, centerX, centerY, scale) {
      const a = config.dimensions.width / 2, b = config.dimensions.height / 2, c = config.dimensions.depth / 2;
      if (config.chessGeometry?.length) {
        let path = '';
        for (const contour of config.chessGeometry) {
          const front = contour.map(point => project({ x: point.x * a, y: point.y * b, z: c }));
          const back = contour.map(point => project({ x: point.x * a, y: point.y * b, z: -c }));
          path += polyPath(front) + polyPath(back);
          for (let index = 0; index < contour.length; index++) {
            const next = (index + 1) % contour.length;
            path += polyPath([front[index], front[next], back[next], back[index]]);
          }
        }
        return path;
      }
      if (config.shape === 'plane') {
        const base = {
          topLeft:{x:-1,y:1}, top:{x:0,y:1}, topRight:{x:1,y:1}, right:{x:1,y:0},
          bottomRight:{x:1,y:-1}, bottom:{x:0,y:-1}, bottomLeft:{x:-1,y:-1}, left:{x:-1,y:0},
        };
        const legacy = typeof config.planeMesh?.top === 'number';
        const meshNode = name => {
          if (legacy) {
            const inset = clamp(Number(config.planeMesh?.[name]) || 0, -0.35, 0.75);
            if (name === 'top') return { x:0, y:1 - inset };
            if (name === 'right') return { x:1 - inset, y:0 };
            if (name === 'bottom') return { x:0, y:-1 + inset };
            if (name === 'left') return { x:-1 + inset, y:0 };
          }
          const value = config.planeMesh?.[name];
          return value && typeof value === 'object'
            ? { x:clamp(Number(value.x) || 0, -1.35, 1.35), y:clamp(Number(value.y) || 0, -1.35, 1.35) }
            : base[name];
        };
        const cornerNames = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
        const edgeNames = ['top', 'right', 'bottom', 'left'];
        const localCorners = cornerNames.map(meshNode).map(point => ({ x:point.x * a, y:point.y * b, z:0 }));
        const localMidpoints = edgeNames.map(meshNode).map(point => ({ x:point.x * a, y:point.y * b, z:0 }));
        const localControls = localMidpoints.map((midpoint, index) => {
          const start = localCorners[index], end = localCorners[(index + 1) % 4];
          return { x:midpoint.x * 2 - (start.x + end.x) / 2, y:midpoint.y * 2 - (start.y + end.y) / 2, z:0 };
        });
        const corners = localCorners.map(project);
        const controls = localControls.map(project);
        let path = `M${corners[0].x.toFixed(2)} ${corners[0].y.toFixed(2)}`;
        for (let index = 0; index < 4; index++) {
          const next = corners[(index + 1) % 4], control = controls[index];
          path += `Q${control.x.toFixed(2)} ${control.y.toFixed(2)} ${next.x.toFixed(2)} ${next.y.toFixed(2)}`;
        }
        return path + 'Z';
      }
      if (config.shape === 'cube') {
        const points = [];
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1])
          points.push(project({ x: sx * a, y: sy * b, z: sz * c }));
        return polyPath(hull(points));
      }
      const silhouette = ellipsoid(matrix, a, b, c);
      let path = ellipsePath(centerX, centerY, silhouette.rx * scale, silhouette.ry * scale, silhouette.angle);
      if (config.shape === 'mickey') {
        const earRadius = 0.52 * Math.min(a, b);
        for (const side of [-1, 1]) {
          const center = project({ x: side * 0.72 * a, y: 0.74 * b, z: 0 });
          path += ellipsePath(center.x, center.y, earRadius * scale, earRadius * scale, 0);
        }
      }
      return path;
    }
    function eyePath(side, matrix, project, scale) {
      const eye = side === 'left' ? config.eyes.left : config.eyes.right;
      const sign = side === 'left' ? -1 : 1;
      const orbiting = config.expression === 'orbit';
      let longitude = sign * 13 + (eye.positionX + eye.offsetX) * 0.35 + pointerX * 14;
      let latitude = 9 + (eye.positionY - eye.offsetY) * 0.35 - pointerY * 10;
      if (orbiting) {
        longitude = sign * 13 + orbitAngle;
        latitude = 9 + Math.sin(elapsed * config.orbit.latitudeSpeed + (side === 'left' ? 0 : 1.25)) * config.orbit.latitudeAmplitude;
      }
      const a = config.dimensions.width / 2 * 0.92;
      const b = config.dimensions.height / 2 * 0.92;
      let c = config.dimensions.depth / 2 * 0.92;
      if (config.shape === 'plane') c = orbiting ? Math.max(10, Math.min(a, b) * 0.16) : Math.min(c, 2);
      const lon = longitude * D2R, lat = latitude * D2R;
      const u = { x: Math.cos(lat) * Math.sin(lon), y: Math.sin(lat), z: Math.cos(lat) * Math.cos(lon) };
      let position, tangentX, tangentY, normal;
      if (!orbiting && (config.shape === 'cube' || config.shape === 'plane' || config.chessGeometry?.length)) {
        const nx = clamp(Math.tan(lon) * 0.9, -FACE_REACH, FACE_REACH);
        const ny = clamp(Math.tan(lat) * 0.9, -FACE_REACH, FACE_REACH);
        position = apply(matrix, { x: a * nx, y: b * ny, z: c + config.eyeDistance });
        normal = norm(apply(matrix, { x: 0, y: 0, z: 1 }));
        tangentX = norm(apply(matrix, { x: 1, y: 0, z: 0 }));
        tangentY = norm(apply(matrix, { x: 0, y: 1, z: 0 }));
      } else {
        const localNormal = norm({ x: u.x / a, y: u.y / b, z: u.z / c });
        position = apply(matrix, {
          x: a * u.x + localNormal.x * config.eyeDistance,
          y: b * u.y + localNormal.y * config.eyeDistance,
          z: c * u.z + localNormal.z * config.eyeDistance,
        });
        normal = norm(apply(matrix, localNormal));
        tangentX = norm(apply(matrix, { x: a * Math.cos(lon), y: 0, z: -c * Math.sin(lon) }));
        tangentY = norm(apply(matrix, { x: -a * Math.sin(lat) * Math.sin(lon), y: b * Math.cos(lat), z: -c * Math.sin(lat) * Math.cos(lon) }));
      }
      const point = { x: width / 2 + position.x * scale, y: height / 2 - position.y * scale };
      const proportion = eye.proportion / 50;
      const eyeHeight = Math.max(3.5, eye.height * proportion * (1 - 0.93 * blink));
      const toScreen = local => ({
        x: point.x + (tangentX.x * local.x - tangentY.x * local.y) * scale,
        y: point.y + (-tangentX.y * local.x + tangentY.y * local.y) * scale,
      });
      const liftRatioEarly = config.eyeDistance / Math.max(1, Math.min(a, b, c));
      if (isTraced(eye.outline) && !orbiting && !eye.lid && !eye.bend) {
        const rearEdge = -Math.sqrt(Math.max(0, 1 - 1 / ((1 + liftRatioEarly) ** 2)));
        const seen = clamp((normal.z - rearEdge) / 0.16, 0, 1);
        return {
          path: cubicPath(tracedNodes(eye.outline, eye.width * proportion, eyeHeight, eye.tilt * D2R), toScreen),
          opacity: seen * seen * (3 - 2 * seen),
        };
      }
      const points = eyePoints(eye.width * proportion, eyeHeight, eye.tilt * D2R, eye.lid, eye.bend,
        orbiting ? 128 : 160, eye.outline);
      const output = points.map(toScreen);
      const liftRatio = config.eyeDistance / Math.max(1, Math.min(a, b, c));
      const rearHorizon = -Math.sqrt(Math.max(0, 1 - 1 / ((1 + liftRatio) ** 2)));
      const visibility = clamp((normal.z - rearHorizon) / 0.16, 0, 1);
      return { path: smoothPath(output), opacity: visibility * visibility * (3 - 2 * visibility) };
    }
    function mouthPath(matrix, scale) {
      const spec = config.mouth;
      if (!spec || spec.width <= 0 || spec.height <= 0 || config.expression === 'orbit') {
        return { path: '', opacity: 0 };
      }
      const longitude = (spec.offsetX * 0.35 + pointerX * 14) * D2R;
      const latitude = (9 - spec.drop - pointerY * 10) * D2R;
      const a = config.dimensions.width / 2 * 0.92;
      const b = config.dimensions.height / 2 * 0.92;
      let c = config.dimensions.depth / 2 * 0.92;
      if (config.shape === 'plane') c = Math.min(c, 2);
      const u = {
        x: Math.cos(latitude) * Math.sin(longitude),
        y: Math.sin(latitude),
        z: Math.cos(latitude) * Math.cos(longitude),
      };
      let position, tangentX, tangentY, normal;
      if (config.shape === 'cube' || config.shape === 'plane' || config.chessGeometry?.length) {
        const nx = clamp(Math.tan(longitude) * 0.9, -FACE_REACH, FACE_REACH);
        const ny = clamp(Math.tan(latitude) * 0.9, -FACE_REACH, FACE_REACH);
        position = apply(matrix, { x: a * nx, y: b * ny, z: c + config.eyeDistance });
        normal = norm(apply(matrix, { x: 0, y: 0, z: 1 }));
        tangentX = norm(apply(matrix, { x: 1, y: 0, z: 0 }));
        tangentY = norm(apply(matrix, { x: 0, y: 1, z: 0 }));
      } else {
        const localNormal = norm({ x: u.x / a, y: u.y / b, z: u.z / c });
        position = apply(matrix, {
          x: a * u.x + localNormal.x * config.eyeDistance,
          y: b * u.y + localNormal.y * config.eyeDistance,
          z: c * u.z + localNormal.z * config.eyeDistance,
        });
        normal = norm(apply(matrix, localNormal));
        tangentX = norm(apply(matrix, { x: a * Math.cos(longitude), y: 0, z: -c * Math.sin(longitude) }));
        tangentY = norm(apply(matrix, {
          x: -a * Math.sin(latitude) * Math.sin(longitude),
          y: b * Math.cos(latitude),
          z: -c * Math.sin(latitude) * Math.cos(longitude),
        }));
      }
      const point = { x: width / 2 + position.x * scale, y: height / 2 - position.y * scale };
      const toScreen = local => ({
        x: point.x + (tangentX.x * local.x - tangentY.x * local.y) * scale,
        y: point.y + (-tangentX.y * local.x + tangentY.y * local.y) * scale,
      });
      const visibility = clamp((normal.z - 0.02) / 0.14, 0, 1);
      const opacity = visibility * visibility * (3 - 2 * visibility);
      if (isTraced(spec.outline) && !spec.curve) {
        return { path: cubicPath(tracedNodes(spec.outline, spec.width, spec.height, spec.tilt * D2R), toScreen), opacity };
      }
      const points = eyePoints(spec.width, spec.height, spec.tilt * D2R, 0, -spec.curve, 160, spec.outline);
      return { path: smoothPath(points.map(toScreen)), opacity };
    }
    function render(time) {
      const dt = clamp((time - previousTime) / 1000, 0.001, 1 / 30);
      previousTime = time; elapsed += dt;
      if (config.expression === 'orbit') orbitAngle = (orbitAngle + config.orbit.speed * dt) % 360;
      if (blinkTimer > 0) {
        blinkTimer -= dt;
        if (blinkTimer <= 0) blinkTarget = 0;
      }
      blink += (blinkTarget - blink) * (1 - Math.exp(-dt * 30));
      const motion = config.motion.enabled ? config.motion : { amplitude: [0, 0, 0], frequency: 0 };
      const phase = elapsed * motion.frequency * TAU;
      const rx = rotation.x + motion.amplitude[0] * Math.sin(phase * 0.9 + 1.3) + pointerY * 8;
      const ry = rotation.y + motion.amplitude[1] * Math.sin(phase * 0.7 + 4.1) + pointerX * 12;
      const rz = rotation.z + motion.amplitude[2] * Math.sin(phase * 0.55 + 7.7);
      const matrix = rotationMatrix(rx * D2R, ry * D2R, rz * D2R);
      const scale = Math.min(width, height) / 560;
      const project = projectFactory(matrix, scale, width / 2, height / 2);
      head.setAttribute('d', headPath(matrix, project, width / 2, height / 2, scale));
      const left = eyePath('left', matrix, project, scale);
      const right = eyePath('right', matrix, project, scale);
      leftEye.setAttribute('d', left.path); leftEye.setAttribute('fill-opacity', left.opacity.toFixed(3));
      rightEye.setAttribute('d', right.path); rightEye.setAttribute('fill-opacity', right.opacity.toFixed(3));
      const mouthGeometry = mouthPath(matrix, scale);
      mouth.setAttribute('d', mouthGeometry.path); mouth.setAttribute('fill-opacity', mouthGeometry.opacity.toFixed(3));
      if (gradient) gradient.setAttribute('gradientTransform', `rotate(${(elapsed * 12) % 360} .5 .5)`);
      animationFrame = requestAnimationFrame(render);
    }
    function blinkNow() { blinkTarget = 1; blinkTimer = 0.09; }
    svg.addEventListener('click', blinkNow);
    svg.addEventListener('pointermove', event => {
      if (drag) {
        rotation.y += (event.clientX - drag.x) * 0.45;
        rotation.x -= (event.clientY - drag.y) * 0.45;
        drag = { x: event.clientX, y: event.clientY };
      }
      const rect = svg.getBoundingClientRect();
      pointerX = clamp((event.clientX - rect.left) / rect.width * 2 - 1, -1, 1);
      pointerY = clamp((event.clientY - rect.top) / rect.height * 2 - 1, -1, 1);
    });
    svg.addEventListener('pointerdown', event => { drag = { x: event.clientX, y: event.clientY }; svg.setPointerCapture(event.pointerId); });
    svg.addEventListener('pointerup', event => { drag = null; svg.releasePointerCapture(event.pointerId); });
    svg.addEventListener('pointerleave', () => { if (!drag) { pointerX = 0; pointerY = 0; } });
    animationFrame = requestAnimationFrame(render);
    return {
      element: host,
      blink: blinkNow,
      setRotation(next) { Object.assign(rotation, next); },
      destroy() { cancelAnimationFrame(animationFrame); resizeObserver.disconnect(); host.remove(); },
    };
  }

  function runtimeSource(snapshot) {
    const body = createAvatar.toString().replace(/^function createAvatar/, 'export function createAvatar');
    return `const DEFAULT_CONFIG = ${JSON.stringify(snapshot, null, 2)};\n\n${body}\n\nexport { DEFAULT_CONFIG as avatarConfig };\n`;
  }

  function javascriptFiles(snapshot) {
    return {
      'kozi-avatar-js/package.json': JSON.stringify({
        name: 'kozi-avatar-js', version: '1.0.0', private: true, type: 'module',
        scripts: { dev: 'npx serve .' },
      }, null, 2) + '\n',
      'kozi-avatar-js/avatar.js': runtimeSource(snapshot),
      'kozi-avatar-js/index.html': `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>2D/3D Avatar</title>
<style>*{box-sizing:border-box}html,body,#avatar{width:100%;height:100%;margin:0}body{background:#d9d9d3}#avatar{min-height:420px}</style></head>
<body><main id="avatar"></main><script type="module">import { createAvatar } from './avatar.js'; createAvatar(document.querySelector('#avatar'));</script></body></html>`,
      'kozi-avatar-js/README.md': `# 2D/3D Avatar — JavaScript module

The exported avatar is dependency-free and carries the configuration that was active at export time.

\`\`\`js
import { createAvatar } from './avatar.js';

const avatar = createAvatar(document.querySelector('#avatar'));
avatar.blink();
avatar.setRotation({ y: 20 });
// avatar.destroy();
\`\`\`

Open \`index.html\` through a local web server. For example, run \`npm run dev\` and follow the printed URL.
`,
    };
  }

  function reactFiles(snapshot) {
    return {
      'kozi-avatar-react/package.json': JSON.stringify({
        name: 'kozi-avatar-react', version: '1.0.0', private: true, type: 'module',
        scripts: { dev: 'vite', build: 'tsc -b && vite build' },
        dependencies: { '@vitejs/plugin-react': '^5.0.0', vite: '^7.0.0', typescript: '^5.8.0', react: '^19.0.0', 'react-dom': '^19.0.0' },
        devDependencies: { '@types/react': '^19.0.0', '@types/react-dom': '^19.0.0' },
      }, null, 2) + '\n',
      'kozi-avatar-react/index.html': '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>2D/3D Avatar</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
      'kozi-avatar-react/tsconfig.json': JSON.stringify({
        compilerOptions: { target: 'ES2022', useDefineForClassFields: true, lib: ['ES2022', 'DOM', 'DOM.Iterable'], allowJs: true, skipLibCheck: true, esModuleInterop: true, allowSyntheticDefaultImports: true, strict: true, forceConsistentCasingInFileNames: true, module: 'ESNext', moduleResolution: 'Bundler', resolveJsonModule: true, isolatedModules: true, noEmit: true, jsx: 'react-jsx' }, include: ['src']
      }, null, 2) + '\n',
      'kozi-avatar-react/src/avatar.js': runtimeSource(snapshot),
      'kozi-avatar-react/src/avatar.d.ts': `export type AvatarController = { element: HTMLElement; blink(): void; setRotation(rotation: Partial<{x:number;y:number;z:number}>): void; destroy(): void };
export declare const avatarConfig: Record<string, unknown>;
export declare function createAvatar(container: HTMLElement, options?: Record<string, unknown>): AvatarController;
`,
      'kozi-avatar-react/src/Avatar.tsx': `import { CSSProperties, useEffect, useRef } from 'react';
import { createAvatar } from './avatar.js';

export type AvatarProps = {
  className?: string;
  style?: CSSProperties;
  config?: Record<string, unknown>;
  onReady?: (avatar: ReturnType<typeof createAvatar>) => void;
};

export function Avatar({ className, style, config, onReady }: AvatarProps) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const avatar = createAvatar(host.current, config);
    onReady?.(avatar);
    return () => avatar.destroy();
  }, [config, onReady]);
  return <div ref={host} className={className} style={{ width: '100%', height: '100%', minHeight: 320, ...style }} />;
}
`,
      'kozi-avatar-react/src/index.ts': `export { Avatar } from './Avatar';
export type { AvatarProps } from './Avatar';
`,
      'kozi-avatar-react/src/main.tsx': `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Avatar } from './Avatar';
import './style.css';

createRoot(document.getElementById('root')!).render(<StrictMode><Avatar /></StrictMode>);
`,
      'kozi-avatar-react/src/style.css': `*{box-sizing:border-box}html,body,#root{width:100%;height:100%;margin:0}body{background:#d9d9d3;font-family:Arial,sans-serif}#root{min-height:420px}`,
      'kozi-avatar-react/README.md': `# 2D/3D Avatar — React + TypeScript

\`Avatar.tsx\` is a reusable component with the current studio configuration embedded in \`avatar.js\`.

\`\`\`tsx
import { Avatar } from './Avatar';

export default function App() {
  return <Avatar style={{ height: 480 }} />;
}
\`\`\`

Run \`npm install\`, then \`npm run dev\`. The component cleans up its animation and resize observers when it unmounts.
`,
    };
  }

  function makeArchive(format, snapshot) {
    const files = format === 'react' ? reactFiles(snapshot) : javascriptFiles(snapshot);
    return { files, bytes: zipStore(files) };
  }

  function download(format, snapshot) {
    const archive = makeArchive(format, snapshot);
    const blob = new Blob([archive.bytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = format === 'react' ? 'kozi-avatar-react.zip' : 'kozi-avatar-js.zip';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return link.download;
  }

  window.AvatarExporter = { download, makeArchive };
})();
