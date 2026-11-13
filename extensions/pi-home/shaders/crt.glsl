// pi-home CRT shader for Ghostty (`custom-shader`), see VISUAL.md §6.
//
// The effect is only applied while pi-home is on screen: pi-home paints its top row in the
// marker colour #0A0B0C (tier T3). Any other program shows through unchanged, so the shader can
// stay loaded in a window that later runs pi itself.

const vec3 MARKER = vec3(10.0, 11.0, 12.0) / 255.0;
const float CURVE = 0.045;      // barrel distortion strength
const float SCANLINE = 0.18;    // scanline darkening
const float GLOW = 0.28;        // bloom amount
const float ABERRATION = 0.6;   // RGB split in pixels
const float NOISE = 0.02;

vec3 srgbToLinear(vec3 c) {
	return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

bool isMarker(vec3 c) {
	// Ghostty 1.4 hands the shader linear colours (measured: the output is sRGB-encoded on write);
	// accept sRGB values too in case another blending mode is configured. One sRGB step around
	// 10/255 is about 0.0003 in linear space.
	vec3 lin = srgbToLinear(MARKER);
	return all(lessThan(abs(c - lin), vec3(0.00012))) || all(lessThan(abs(c - MARKER), vec3(0.4 / 255.0)));
}

bool markerVisible() {
	// Scan the top and bottom 10% (texture orientation differs between back-ends) at mid width,
	// confirm with a second sample at 30% width.
	for (int i = 0; i < 12; i++) {
		float t = (float(i) + 0.5) / 12.0 * 0.10;
		for (int e = 0; e < 2; e++) {
			float y = (e == 0) ? t : 1.0 - t;
			if (isMarker(texture(iChannel0, vec2(0.5, y)).rgb) && isMarker(texture(iChannel0, vec2(0.3, y)).rgb)) {
				return true;
			}
		}
	}
	return false;
}

vec2 barrel(vec2 uv) {
	vec2 c = uv * 2.0 - 1.0;
	c *= 1.0 + CURVE * dot(c, c);
	return c * 0.5 + 0.5;
}

float hash(vec2 p) {
	return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
	vec2 uv = fragCoord / iResolution.xy;
	if (!markerVisible()) {
		fragColor = texture(iChannel0, uv);
		return;
	}

	vec2 cuv = barrel(uv);
	if (cuv.x < 0.0 || cuv.x > 1.0 || cuv.y < 0.0 || cuv.y > 1.0) {
		fragColor = vec4(0.0, 0.0, 0.0, 1.0);
		return;
	}

	vec2 px = 1.0 / iResolution.xy;
	vec3 col;
	col.r = texture(iChannel0, cuv + vec2(ABERRATION * px.x, 0.0)).r;
	col.g = texture(iChannel0, cuv).g;
	col.b = texture(iChannel0, cuv - vec2(ABERRATION * px.x, 0.0)).b;

	vec3 blur = vec3(0.0);
	blur += texture(iChannel0, cuv + vec2(2.0 * px.x, 0.0)).rgb;
	blur += texture(iChannel0, cuv - vec2(2.0 * px.x, 0.0)).rgb;
	blur += texture(iChannel0, cuv + vec2(0.0, 2.0 * px.y)).rgb;
	blur += texture(iChannel0, cuv - vec2(0.0, 2.0 * px.y)).rgb;
	blur += texture(iChannel0, cuv + vec2(4.0 * px.x, 4.0 * px.y)).rgb;
	col += (blur / 5.0) * GLOW;

	// Scanlines with a 3-pixel period, independent of cell size.
	float scan = 1.0 - SCANLINE * (0.5 + 0.5 * sin(fragCoord.y * 2.0944));
	col *= scan;

	// Vignette in curved space.
	vec2 v = cuv * (1.0 - cuv.yx);
	col *= clamp(pow(v.x * v.y * 18.0, 0.22), 0.0, 1.0);

	col += (hash(fragCoord + fract(iTime)) - 0.5) * NOISE;
	col *= 0.985 + 0.015 * sin(iTime * 120.0);

	fragColor = vec4(col, 1.0);
}
