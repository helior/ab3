
exports.handler = async (event) => {
	console.log(event);
  const labels = event.moderationResults.ModerationLabels;
	return labels.length;
}
