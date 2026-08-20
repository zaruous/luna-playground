function Ear({ x, y, flip = false }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${flip ? -1 : 1} 1)`}>
      <path className="cat-fur" d="M0 18 7 0 22 21Z" />
      <path className="cat-inner" d="M5 16 8 6 16 17Z" />
    </g>
  );
}

function FaceDetails({ x = 0, y = 0, scale = 1 }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <path className="cat-eye" d="M12 18q4 3 8 0" />
      <path className="cat-eye" d="M42 18q4 3 8 0" />
      <path className="cat-nose" d="m31 27 5 0-2.5 4Z" />
      <path className="cat-line" d="M33.5 31v5m0 0q-5 5-10 0m10 0q5 5 10 0" />
      <path className="cat-line whisker" d="M22 31 3 27m19 9L1 37m44-6 19-4m-19 9 21 1" />
    </g>
  );
}

export default function CatArt({ pose = 'face', className = '', label, decorative = false }) {
  const accessibility = decorative
    ? { 'aria-hidden': true }
    : { role: 'img', 'aria-label': label || '현재 스킨의 고양이 드로잉' };

  if (pose === 'face') {
    return (
      <svg className={`cat-art cat-face-art ${className}`} viewBox="0 0 90 90" {...accessibility}>
        <Ear x="13" y="10" />
        <Ear x="76" y="10" flip />
        <circle className="cat-fur" cx="45" cy="49" r="31" />
        <path className="cat-patch cat-patch-a" d="M20 30q14-16 29-8l-8 20q-11 4-21-12Z" />
        <path className="cat-patch cat-patch-b" d="M53 24q16 5 21 18l-18 4q-8-9-3-22Z" />
        <ellipse className="cat-muzzle" cx="45" cy="60" rx="19" ry="13" />
        <FaceDetails x="12" y="32" scale="1" />
      </svg>
    );
  }

  if (pose === 'peek') {
    return (
      <svg className={`cat-art ${className}`} viewBox="0 0 190 104" {...accessibility}>
        <Ear x="46" y="6" />
        <Ear x="143" y="6" flip />
        <ellipse className="cat-fur" cx="95" cy="61" rx="51" ry="45" />
        <path className="cat-patch cat-patch-a" d="M53 32q25-25 44-12L83 54q-18 9-30-22Z" />
        <path className="cat-patch cat-patch-b" d="M111 22q31 7 38 34l-31 5q-12-18-7-39Z" />
        <ellipse className="cat-muzzle" cx="95" cy="70" rx="25" ry="17" />
        <FaceDetails x="62" y="43" scale="1.05" />
        <ellipse className="cat-fur cat-outline" cx="57" cy="96" rx="25" ry="9" />
        <ellipse className="cat-fur cat-outline" cx="133" cy="96" rx="25" ry="9" />
        <path className="cat-line" d="M44 96h26m50 0h26" />
      </svg>
    );
  }

  if (pose === 'header') {
    return (
      <svg className={`cat-art ${className}`} viewBox="0 0 340 126" {...accessibility}>
        <path className="cat-shadow" d="M34 104q106 18 246 2 31-3 27 8-123 17-273 3-23-3 0-13Z" />
        <path className="cat-fur cat-outline" d="M111 49q68-32 136 11 29 19 53 21 19 2 22 14-7 18-45 5-25-8-42-11-35 24-105 13-45-7-66-30 14-20 47-23Z" />
        <path className="cat-belly" d="M119 69q52-22 111 8-22 28-79 25-32-2-51-17Z" />
        <path className="cat-patch cat-patch-a" d="M170 48q26-13 51 0l-14 28q-28 9-37-28Z" />
        <path className="cat-patch cat-patch-b" d="M226 55q31 7 51 30l-28 13q-28-18-23-43Z" />
        <g transform="translate(70 19)">
          <Ear x="5" y="4" />
          <Ear x="76" y="4" flip />
          <ellipse className="cat-fur" cx="41" cy="50" rx="42" ry="37" />
          <path className="cat-patch cat-patch-a" d="M3 33q18-22 39-13L31 47Q12 52 3 33Z" />
          <ellipse className="cat-muzzle" cx="42" cy="59" rx="20" ry="14" />
          <FaceDetails x="9" y="33" scale="1" />
        </g>
        <path className="cat-line" d="M260 83q35-8 55 6 18 13 4 25-17 15-42-7" />
        <ellipse className="cat-fur cat-outline" cx="122" cy="101" rx="28" ry="9" />
        <ellipse className="cat-fur cat-outline" cx="167" cy="104" rx="27" ry="8" />
      </svg>
    );
  }

  if (pose === 'sleep') {
    return (
      <svg className={`cat-art ${className}`} viewBox="0 0 280 158" {...accessibility}>
        <ellipse className="cat-shadow" cx="142" cy="132" rx="104" ry="17" />
        <path className="cat-fur cat-outline" d="M57 105q10-68 85-75 72-7 101 49 22 42-29 57-66 20-122-1-34-13-35-30Z" />
        <path className="cat-patch cat-patch-a" d="M118 31q38-11 65 8l-18 40q-32 2-47-48Z" />
        <path className="cat-patch cat-patch-b" d="M184 42q35 15 48 43l-35 15q-18-25-13-58Z" />
        <path className="cat-line" d="M219 91q37-23 44 3 8 30-49 35-42 4-75-16" />
        <g transform="translate(54 65)">
          <Ear x="7" y="2" />
          <Ear x="75" y="2" flip />
          <ellipse className="cat-fur" cx="42" cy="45" rx="42" ry="35" />
          <path className="cat-patch cat-patch-b" d="M4 28q20-18 40-8L31 48Q11 51 4 28Z" />
          <ellipse className="cat-muzzle" cx="42" cy="55" rx="19" ry="13" />
          <FaceDetails x="9" y="29" scale="1" />
        </g>
      </svg>
    );
  }

  if (pose === 'sidebar') {
    return (
      <svg className={`cat-art ${className}`} viewBox="0 0 190 310" {...accessibility}>
        <ellipse className="cat-shadow" cx="93" cy="281" rx="68" ry="17" />
        <path className="cat-fur cat-outline" d="M62 113q-21 45-15 112 4 49 29 56 29 8 56 0 23-7 17-59-7-61-26-108Z" />
        <path className="cat-belly" d="M78 143q26-16 46 0 13 58 4 118-25 14-50 0-13-58 0-118Z" />
        <path className="cat-patch cat-patch-a" d="M57 124q18-23 38-18l-3 44q-23 10-35-26Z" />
        <path className="cat-patch cat-patch-b" d="M114 121q24 11 30 40l-25 8q-16-24-5-48Z" />
        <g transform="translate(48 45)">
          <Ear x="2" y="1" />
          <Ear x="88" y="1" flip />
          <ellipse className="cat-fur" cx="45" cy="53" rx="47" ry="42" />
          <path className="cat-patch cat-patch-a" d="M2 31q21-25 44-12L34 52Q12 55 2 31Z" />
          <path className="cat-patch cat-patch-b" d="M55 17q27 9 35 32l-29 6q-14-16-6-38Z" />
          <ellipse className="cat-muzzle" cx="45" cy="64" rx="22" ry="15" />
          <FaceDetails x="12" y="38" scale="1" />
        </g>
        <path className="cat-line" d="M142 218q33 0 28 33-4 29-39 30" />
        <path className="cat-line" d="M72 270v-77m44 77v-78" />
      </svg>
    );
  }

  if (pose === 'yarn') {
    return (
      <svg className={`cat-art ${className}`} viewBox="0 0 330 124" {...accessibility}>
        <ellipse className="cat-shadow" cx="151" cy="108" rx="118" ry="12" />
        <path className="cat-fur cat-outline" d="M63 75q28-48 94-43 58 5 98 48-12 32-89 29-68-2-103-34Z" />
        <path className="cat-belly" d="M104 71q52-26 103 11-29 26-88 17Z" />
        <path className="cat-patch cat-patch-a" d="M141 34q34-7 57 11l-17 32q-31 4-40-43Z" />
        <path className="cat-patch cat-patch-b" d="M199 46q31 10 51 34l-29 15q-25-17-22-49Z" />
        <g transform="translate(35 34)">
          <Ear x="5" y="0" />
          <Ear x="78" y="0" flip />
          <ellipse className="cat-fur" cx="42" cy="45" rx="42" ry="36" />
          <path className="cat-patch cat-patch-b" d="M5 26q18-19 39-9L31 44Q12 50 5 26Z" />
          <ellipse className="cat-muzzle" cx="42" cy="55" rx="20" ry="14" />
          <FaceDetails x="9" y="29" scale="1" />
        </g>
        <circle className="yarn-ball" cx="288" cy="93" r="20" />
        <path className="yarn-line" d="M269 90q14-10 34 1m-30-10q15 2 27 21m-6-28q-3 17-18 31m-8-4q-25 12-45 2" />
      </svg>
    );
  }

  return (
    <svg className={`cat-art ${className}`} viewBox="0 0 360 360" {...accessibility}>
      <circle className="cat-backdrop-disc" cx="180" cy="180" r="156" />
      <Ear x="84" y="56" />
      <Ear x="270" y="56" flip />
      <ellipse className="cat-fur" cx="180" cy="191" rx="112" ry="103" />
      <path className="cat-patch cat-patch-a" d="M83 145q47-69 104-43l-31 87q-50 21-73-44Z" />
      <path className="cat-patch cat-patch-b" d="M202 101q68 15 93 81l-65 19q-40-45-28-100Z" />
      <ellipse className="cat-muzzle" cx="180" cy="229" rx="60" ry="43" />
      <FaceDetails x="96" y="148" scale="2.55" />
    </svg>
  );
}
