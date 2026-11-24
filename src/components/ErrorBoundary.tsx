import { Component, type ErrorInfo, type ReactNode } from 'react';
import { userFacingError } from '../lib/user-facing-error';
import './error-boundary.css';

interface Props {
	children: ReactNode;
	label?: string;
	inline?: boolean;
	resetKey?: string | number | null;
	onReset?: () => void;
}

interface State {
	error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error(`Uncaught UI error${this.props.label ? ` in ${this.props.label}` : ''}:`, error, info.componentStack);
	}

	componentDidUpdate(prevProps: Props) {
		if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
			this.setState({ error: null });
		}
	}

	private retry = () => {
		this.setState({ error: null });
		this.props.onReset?.();
	};

	render() {
		if (!this.state.error) return this.props.children;
		const message = userFacingError(this.state.error);
		const title = this.props.label
			? `${this.props.label} ran into an unexpected error`
			: 'FreeLM ran into an unexpected error';
		return (
			<div
				className={`error-boundary ${this.props.inline ? 'error-boundary-inline' : 'error-boundary-full'}`}
				role="alert"
			>
				<div className="error-boundary-card">
					<h2>{title}</h2>
					<p>{message}</p>
					<div className="error-boundary-actions">
						<button type="button" className="primary-button" onClick={this.retry}>
							Try again
						</button>
						{!this.props.inline && (
							<button
								type="button"
								className="secondary-button"
								onClick={() => window.location.reload()}
							>
								Reload FreeLM
							</button>
						)}
					</div>
				</div>
			</div>
		);
	}
}
