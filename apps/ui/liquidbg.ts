// liquidbg.ts
export function initLiquidBackground() {
  // Create a fullscreen canvas for the background
  const canvas = document.createElement('canvas');
  canvas.className = 'liquid-bg-canvas';
  document.body.prepend(canvas); // put it behind the rest of the DOM

  const gl = canvas.getContext('webgl');
  if (!gl) {
    console.warn('WebGL not supported');
    return;
  }

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  resize();
  window.addEventListener('resize', resize);

  const vsSource = `
    attribute vec2 aPosition;
    void main() {
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;

  const fsSource = `
    precision highp float;

    uniform vec2 uResolution;
    uniform float uTime;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);

      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));

      vec2 u = f * f * (3.0 - 2.0 * f);

      return mix(a, b, u.x) +
             (c - a) * u.y * (1.0 - u.x) +
             (d - b) * u.x * u.y;
    }

    float fbm(vec2 p) {
      float value = 0.0;
      float amp = 0.5;
      float freq = 1.0;
      for (int i = 0; i < 5; i++) {
        value += amp * noise(p * freq);
        freq *= 2.0;
        amp *= 0.5;
      }
      return value;
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / uResolution.xy;
      uv -= 0.5;
      uv.x *= uResolution.x / uResolution.y;

      float t = uTime * 0.35;

      vec2 p = uv * 2.0;
      float n1 = fbm(p + vec2(t, 0.0));
      float n2 = fbm(p - vec2(0.0, t));
      float n = fbm(p + vec2(n1, n2));

      // palette close to your purple-ish scheme
      // --- PURPLE → ORANGE LIQUID PALETTE ---
      // --- RADICAL PURPLE ↔ ORANGE PALETTE ---
      vec3 col1 = vec3(0.03, 0.00, 0.18);  // deeper, darker midnight base
      vec3 col2 = vec3(0.52, 0.30, 1.00);  // neon violet
      vec3 col3 = vec3(0.88, 0.40, 1.00);  // electric magenta highlight
      vec3 col4 = vec3(1.10, 0.65, 0.10);  // hot orange (slightly over-driven)
      vec3 col5 = vec3(1.30, 0.32, 0.00);  // molten red-orange (over-saturated)


      // bands define how colors blend through the noise
      float band1 = smoothstep(0.10, 0.60, n);
      float band2 = smoothstep(0.40, 0.85, n);
      float band3 = smoothstep(0.55, 0.85, n);
      float band4 = smoothstep(0.65, 1.15, n);

      // build gradient progression
      vec3 color = col1;
      color = mix(color, col2, band1*1.2);
      color = mix(color, col3, band2*1.2);
      color = mix(color, col4, band3 * 1.5); 
      color = mix(color, col5, band4 * 1.7);


      float radius = length(uv);
      float vignette = smoothstep(1.2, 0.2, radius);
      color *= vignette;

      gl_FragColor = vec4(color, 1.0);
    }
  `;

  const createShader = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const vertShader = createShader(gl.VERTEX_SHADER, vsSource);
  const fragShader = createShader(gl.FRAGMENT_SHADER, fsSource);
  if (!vertShader || !fragShader) return;

  const program = gl.createProgram()!;
  gl.attachShader(program, vertShader);
  gl.attachShader(program, fragShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(program));
    return;
  }

  gl.useProgram(program);

  const vertices = new Float32Array([
    -1, -1,
     1, -1,
    -1,  1,
    -1,  1,
     1, -1,
     1,  1,
  ]);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

  const aPosition = gl.getAttribLocation(program, 'aPosition');
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

  const uResolution = gl.getUniformLocation(program, 'uResolution');
  const uTime = gl.getUniformLocation(program, 'uTime');

  let start = performance.now();
  let frameId: number;

  const render = () => {
    const now = performance.now();
    const t = (now - start) / 1000;

    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform1f(uTime, t);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    frameId = requestAnimationFrame(render);
  };

  render();

  // optional: cleanup if you ever need it
  return () => {
    cancelAnimationFrame(frameId);
    window.removeEventListener('resize', resize);
    gl.deleteProgram(program);
    gl.deleteShader(vertShader);
    gl.deleteShader(fragShader);
    gl.deleteBuffer(buffer);
  };
}
