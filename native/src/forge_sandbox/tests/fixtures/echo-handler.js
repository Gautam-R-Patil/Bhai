// Test fixture for shim integration. Echoes the input back as the result.
module.exports = async function(input) {
    return { echoed: input };
};
