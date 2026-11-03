export function motionScrollBehavior(): ScrollBehavior {
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

/** Cancel immediately if the preference changes, and detach listeners when finished. */
export function animateEntrance(element: HTMLElement, keyframes: Keyframe[]) {
	const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
	if (preference.matches || !element.animate) return;
	const style = getComputedStyle(element);
	const animation = element.animate(keyframes, {
		duration: parseFloat(style.getPropertyValue('--motion-enter')) || 240,
		easing: style.getPropertyValue('--motion-ease-enter').trim() || 'ease-out',
	});
	const cancel = () => {
		if (preference.matches) animation.cancel();
	};
	preference.addEventListener('change', cancel);
	const cleanup = () => preference.removeEventListener('change', cancel);
	animation.finished.then(cleanup, cleanup);
	return animation;
}
