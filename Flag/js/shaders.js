export const vertexShader = `
attribute vec3 aPos, aNrm;
attribute vec2 aUV;
uniform mat4 uProj, uView;
varying vec3 vNrm, vPos;
varying vec2 vUV;
void main() {
  vNrm = aNrm;
  vPos = aPos;
  vUV = aUV;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

export const fragmentShader = `
precision highp float;
varying vec3 vNrm, vPos;
varying vec2 vUV;
uniform vec3 uLight, uColor, uEye;
uniform sampler2D uTex;
uniform float uFace, uAlpha, uAmbient;
uniform bool uHasTex;

void main() {
  vec3 n = normalize(vNrm) * uFace;
  vec3 vd = normalize(uEye - vPos);
  vec3 ld = normalize(uLight);
  vec3 hd = normalize(ld + vd);

  float ndl = dot(n, ld);
  float diff = max(ndl, 0.0) * 0.50;
  float fill = max(dot(n, normalize(vec3(-0.45, 0.35, -0.65))), 0.0) * 0.14;
  float back = max(-ndl, 0.0) * 0.20;
  float rim = pow(1.0 - max(dot(n, vd), 0.0), 2.8) * 0.18;
  float spec = pow(max(dot(n, hd), 0.0), 72.0) * 0.14;
  float spec2 = pow(max(dot(n, hd), 0.0), 16.0) * 0.16;
  float light = uAmbient + diff + fill + back + rim + spec + spec2;

  vec3 base = uColor;
  float alpha = uAlpha;
  if (uHasTex) {
    vec2 tc = vUV;
    if (uFace < 0.0) tc.x = 1.0 - tc.x;
    vec4 t = texture2D(uTex, tc);
    base = t.rgb + base * (uAlpha * (1.0 - t.a));
    alpha = t.a + uAlpha * (1.0 - t.a);
  }

  float sheen = pow(1.0 - max(dot(n, vd), 0.0), 4.0) * 0.07;
  vec3 sheenTint = mix(vec3(0.84, 0.90, 0.98), vec3(0.98, 0.90, 0.84), vUV.y);
  vec3 lit = base * light + sheenTint * sheen;

  gl_FragColor = vec4(lit, alpha);
}`;
