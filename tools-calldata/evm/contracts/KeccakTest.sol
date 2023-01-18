pragma solidity 0.6.7;


contract KeccakTest {

    function hashmultiple(uint256[2] calldata input, uint times) external pure returns (bytes32 result) {
        uint i = 0;
        bytes32 tmp;
        for (i = 0; i < times; i += 1) {
            tmp = keccak256(abi.encodePacked(input[0], input[1]));
        }
        result = tmp;
    }
}
