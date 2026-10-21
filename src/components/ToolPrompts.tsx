import { useId, useState } from 'react';
import { ChevronLeft, ChevronRight, CircleHelp, Pencil, X } from 'lucide-react';
import type { UserQuestion } from '../lib/interaction-tools';
import './tool-activity.css';

export interface PendingQuestions {
	id: string;
	questions: UserQuestion[];
	answer: (answers: Record<string, { answers: string[] }>) => void;
}

interface ToolPromptsProps {
	questions?: PendingQuestions | null;
	active?: boolean;
	answers?: Record<string, string>;
	onAnswersChange?: (answers: Record<string, string>) => void;
}

export function ToolPrompts(props: ToolPromptsProps) {
	if (!props.questions?.questions.length) return null;
	return <QuestionSheet key={props.questions.id} {...props} questions={props.questions} />;
}

function QuestionSheet({
	questions,
	active = true,
	answers: controlledAnswers,
	onAnswersChange,
}: ToolPromptsProps & { questions: PendingQuestions }) {
	const [localAnswers, setLocalAnswers] = useState<Record<string, string>>({});
	const [customResponses, setCustomResponses] = useState<Record<string, boolean>>({});
	const [page, setPage] = useState(0);
	const [minimized, setMinimized] = useState(false);
	const descriptionId = useId();
	const answers = controlledAnswers ?? localAnswers;
	const currentPage = Math.min(page, questions.questions.length - 1);
	const question = questions.questions[currentPage];
	const answer = answers[question.id] || '';
	const isCustomAnswer =
		customResponses[question.id] || !question.options.some((option) => option.label === answer);
	const lastPage = currentPage === questions.questions.length - 1;
	const allAnswered = questions.questions.every((item) => answers[item.id]?.trim());

	function changeAnswer(value: string, custom: boolean) {
		if (!active) return;
		const next = { ...answers, [question.id]: value };
		setCustomResponses((previous) => ({ ...previous, [question.id]: custom }));
		if (onAnswersChange) onAnswersChange(next);
		else setLocalAnswers(next);
	}

	if (minimized) {
		return (
			<section
				className="tool-question-minimized"
				role="region"
				aria-label="Assistant question"
				hidden={!active}
			>
				<button
					type="button"
					className="tool-question-reopen"
					onClick={() => {
						if (active) setMinimized(false);
					}}
				>
					<CircleHelp size={16} aria-hidden="true" />
					Question
				</button>
			</section>
		);
	}

	return (
		<section
			className="tool-prompt tool-question-sheet"
			role="region"
			aria-label="Assistant question"
			hidden={!active}
		>
			<form
				className="tool-question-form"
				onSubmit={(event) => {
					event.preventDefault();
					if (!active || !lastPage || !allAnswered) return;
					questions.answer(
						Object.fromEntries(
							questions.questions.map((item) => [item.id, { answers: [answers[item.id].trim()] }]),
						),
					);
				}}
			>
				<header className="tool-question-header">
					<h2>
						<CircleHelp size={17} aria-hidden="true" />
						Question
					</h2>
					{questions.questions.length > 1 && (
						<span className="tool-question-page">
							{currentPage + 1} of {questions.questions.length}
						</span>
					)}
					<button
						type="button"
						className="icon-button tool-question-minimize"
						aria-label="Minimize question"
						onClick={() => {
							if (active) setMinimized(true);
						}}
					>
						<X size={17} aria-hidden="true" />
					</button>
				</header>
				<div className="tool-question-body">
					<fieldset key={question.id}>
						<legend>{question.question}</legend>
						<div className="question-options">
							{question.options.map((option, index) => (
								<button
									type="button"
									key={option.label}
									className={`tool-question-option${!isCustomAnswer && answer === option.label ? ' selected' : ''}`}
									aria-label={option.label}
									aria-pressed={!isCustomAnswer && answer === option.label}
									aria-describedby={
										option.description ? `${descriptionId}-${currentPage}-${index}` : undefined
									}
									onClick={() => changeAnswer(option.label, false)}
								>
									<span className="tool-question-option-number" aria-hidden="true">
										{index + 1}
									</span>
									<span className="tool-question-option-content">
										<span>{option.label}</span>
										{option.description && (
											<small id={`${descriptionId}-${currentPage}-${index}`}>
												{option.description}
											</small>
										)}
									</span>
								</button>
							))}
						</div>
					</fieldset>
					<label className="tool-question-custom">
						<Pencil size={17} aria-hidden="true" />
						<textarea
							aria-label={`Your answer: ${question.question}`}
							placeholder="Or write your own response"
							value={isCustomAnswer ? answer : ''}
							onChange={(event) => changeAnswer(event.target.value, true)}
							rows={1}
						/>
					</label>
				</div>
				<footer className="tool-question-footer">
					{questions.questions.length > 1 && (
						<div className="tool-question-pagination">
							<button
								type="button"
								className="tool-question-page-button"
								disabled={currentPage === 0}
								onClick={() => active && setPage(currentPage - 1)}
							>
								<ChevronLeft size={14} aria-hidden="true" />
								Previous
							</button>
							<button
								type="button"
								className="tool-question-page-button"
								disabled={lastPage || !answer.trim()}
								onClick={() => active && setPage(currentPage + 1)}
							>
								Next
								<ChevronRight size={14} aria-hidden="true" />
							</button>
						</div>
					)}
					<div className="tool-question-actions">
						<button
							type="button"
							className="secondary-button"
							onClick={() => active && questions.answer({})}
						>
							Skip
						</button>
						{lastPage && (
							<button className="primary-button" type="submit" disabled={!allAnswered}>
								Send
							</button>
						)}
					</div>
				</footer>
			</form>
		</section>
	);
}
