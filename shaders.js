// Terrain shader sources
const TERRAIN_VERT = `
precision highp float;
attribute vec3 aPosition;
attribute vec4 aVertexColor;
uniform mat4 uProjectionMatrix;
uniform mat4 uModelViewMatrix;
varying vec4 vColor;
varying vec4 vWorldPos;

void main() {
  vec4 viewSpace = uModelViewMatrix * vec4(aPosition, 1.0);
  gl_Position = uProjectionMatrix * viewSpace;
  vWorldPos = vec4(aPosition, 1.0);
  vColor = aVertexColor;
}
`;

const TERRAIN_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec4 vColor;
varying vec4 vWorldPos;
uniform float uTime;
uniform vec4 uPulses[5];
uniform vec2 uFogDist;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec2 hash2(vec2 p) {
  return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float f = 0.0;
  float amp = 0.5;
  for(int i = 0; i < 3; i++) {
    f += amp * noise(p);
    p *= 2.0;
    amp *= 0.5;
  }
  return f;
}

void main() {  
  vec3 cyberColor = vec3(0.0);
  
  vec3 baseColor = vColor.rgb;
  vec3 texColor = baseColor;
  
  if (vWorldPos.y > 199.0) {
    // Subtle, clean ripple/caustic style inspired by reference image
    vec2 uv = vWorldPos.xz * 0.01; 
    uv += vec2(uTime * 0.05, uTime * 0.03); // Slow, gentle flow
    
    // Multi-layered Voronoi/Noise for a "caustic" look
    float ripple = 0.0;
    
    // First layer
    vec2 pos1 = uv;
    vec2 p1 = floor(pos1);
    vec2 f1 = fract(pos1);
    float minDist1 = 1.0;
    for(int y = -1; y <= 1; y++) {
      for(int x = -1; x <= 1; x++) {
        vec2 neighbor = vec2(float(x), float(y));
        vec2 pt = hash2(p1 + neighbor);
        pt = 0.5 + 0.5 * sin(uTime * 0.8 + 6.2831 * pt);
        minDist1 = min(minDist1, length(neighbor + pt - f1));
      }
    }
    
    // Second layer at different scale
    vec2 pos2 = uv * 2.5 + vec2(uTime * 0.1);
    vec2 p2 = floor(pos2);
    vec2 f2 = fract(pos2);
    float minDist2 = 1.0;
    for(int y = -1; y <= 1; y++) {
      for(int x = -1; x <= 1; x++) {
        vec2 neighbor = vec2(float(x), float(y));
        vec2 pt = hash2(p2 + neighbor);
        pt = 0.5 + 0.5 * sin(uTime * 1.2 + 6.2831 * pt);
        minDist2 = min(minDist2, length(neighbor + pt - f2));
      }
    }
    
    // Combine layers to get "thin" lines (caustics)
    ripple = pow(minDist1, 0.5) * minDist2; 
    
    // Toon-shading style thresholds for highlights
    float highlight = smoothstep(0.3, 0.35, ripple);
    
    // Much more subtle water colors, based on the reference turquoise palette
    vec3 shallow = vec3(0.15, 0.7, 0.75); // Toned down
    vec3 deep = vec3(0.12, 0.65, 0.7);   // Very close to shallow
    
    texColor = mix(shallow, deep, ripple);
    
    // Much subtler caustic highlights
    float caustic = smoothstep(0.75, 0.85, 1.0 - ripple);
    texColor += vec3(0.1, 0.12, 0.12) * caustic; // Reduced addition

  } else {
    // Solid Landscape: plain untextured appearance 
    // Uses the raw base color coming from the vertex buffer without any noise overlay
    texColor = baseColor;
  }

  // Bomb drop pulses
  for (int i = 0; i < 5; i++) {
    float age = uTime - uPulses[i].z;
    if (age >= 0.0 && age < 3.0) { // Lasts for 3 seconds
      float type = uPulses[i].w;
      // Scale differences by 0.01 before taking length to avoid fp16 overflow on mobile
      vec2 diff = (vWorldPos.xz - uPulses[i].xy) * 0.01;
      float distToPulse = length(diff) * 100.0;
      
      float radius = type == 1.0 ? age * 300.0 : (type == 2.0 ? age * 1200.0 : age * 800.0); // type 2 is ship explosion
      float ringThickness = type == 1.0 ? 30.0 : (type == 2.0 ? 150.0 : 80.0);
      float ring = smoothstep(radius - ringThickness, radius, distToPulse) * (1.0 - smoothstep(radius, radius + ringThickness, distToPulse));
      
      float fade = 1.0 - (age / 3.0);
      vec3 pulseColor = type == 1.0 ? vec3(0.2, 0.6, 1.0) : (type == 2.0 ? vec3(1.0, 0.8, 0.2) : vec3(1.0, 0.1, 0.1)); // Blue crab, yellow ship, red bomb
      cyberColor += pulseColor * ring * fade * 2.0; 
    }
  }
  
  vec3 outColor = texColor + cyberColor;
  
  // Apply fog to smoothly hide chunk loading edges
  float dist = gl_FragCoord.z / gl_FragCoord.w;
  float fogFactor = smoothstep(uFogDist.x, uFogDist.y, dist);
  vec3 fogColor = vec3(30.0 / 255.0, 60.0 / 255.0, 120.0 / 255.0);
  outColor = mix(outColor, fogColor, fogFactor);

  gl_FragColor = vec4(outColor, vColor.a);
}
`;
