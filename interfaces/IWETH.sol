pragma solidity 0.8.6;

interface IWETH {
    function balanceOf(address account) external view returns (uint256);
    function approve(address to, uint256 wad) external;
    function deposit(uint256 wad) external;
    function withdraw(uint256 wad) external;
    function transfer(address to, uint256 wad) external;
    function trasnferFrom(address from, address to, uint256 wad) external;
}
